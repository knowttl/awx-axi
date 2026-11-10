import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const allowances = {
  "cli.ts": { streams: 3, encodes: 2 },
  "core/auth.ts": { streams: 1 },
  "core/profiles.ts": { streams: 1 },
  "core/transport.ts": { streams: 1 },
  "core/errors.ts": { encodes: 2 },
  "core/output.ts": { encodes: 2 },
  "domains/host/index.ts": { encodes: 4 },
};

const PROCESS_MODULES = ["node:process", "process"];
const TOON_MODULE = "@toon-format/toon";
const STREAMS = ["stdout", "stderr"];
const GLOBAL_OBJECTS = ["globalThis", "global"];

function literalText(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function unwrap(node) {
  while (node && (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) node = node.expression;
  return node;
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  return literalText(node.argumentExpression);
}

function isMemberAccess(node) {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function collectProcessAliases(source) {
  const aliases = new Set(["process"]);
  function isProcessReference(node) {
    node = unwrap(node);
    if (!node) return false;
    if (ts.isIdentifier(node)) return aliases.has(node.text);
    return isMemberAccess(node) && memberName(node) === "process" && ts.isIdentifier(unwrap(node.expression)) && GLOBAL_OBJECTS.includes(unwrap(node.expression).text);
  }
  function visit(node) {
    if (ts.isImportDeclaration(node) && PROCESS_MODULES.includes(node.moduleSpecifier.text)) {
      const clause = node.importClause;
      if (clause?.name) aliases.add(clause.name.text);
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) aliases.add(clause.namedBindings.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && isProcessReference(node.initializer)) aliases.add(node.name.text);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(unwrap(node.left)) && isProcessReference(node.right)) aliases.add(unwrap(node.left).text);
    ts.forEachChild(node, visit);
  }
  let size;
  do {
    size = aliases.size;
    visit(source);
  } while (aliases.size !== size);
  return { aliases, isProcessReference };
}

function isStreamName(name) {
  if (!name) return false;
  if (ts.isComputedPropertyName(name) && ts.isNumericLiteral(name.expression)) return false;
  const text = ts.isComputedPropertyName(name) ? literalText(name.expression) : name.text;
  return text === undefined || STREAMS.includes(text);
}

export function checkOutput(sources) {
  const errors = [];
  for (const [name, text] of sources) {
    const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
    const allowed = allowances[name] ?? {};
    const { isProcessReference } = collectProcessAliases(source);
    let streams = 0;
    let encodes = 0;
    function visit(node) {
      if (ts.isIdentifier(node) && node.text === "console") errors.push(`${name}: console output`);
      if (isMemberAccess(node) && isProcessReference(node.expression)) {
        const member = memberName(node);
        if (ts.isElementAccessExpression(node) ? member === undefined || STREAMS.includes(member) : STREAMS.includes(member)) streams++;
      }
      if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && isProcessReference(node.initializer)) {
        streams += node.name.elements.filter((element) => isStreamName(element.propertyName ?? element.name)).length;
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isObjectLiteralExpression(unwrap(node.left)) && isProcessReference(node.right)) {
        streams += unwrap(node.left).properties.filter((property) => (ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)) && isStreamName(property.name)).length;
      }
      if (ts.isImportDeclaration(node) && PROCESS_MODULES.includes(node.moduleSpecifier.text)) {
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) => STREAMS.includes((element.propertyName ?? element.name).text))) errors.push(`${name}: imported process stream`);
      }
      if (ts.isImportDeclaration(node) && node.moduleSpecifier.text === TOON_MODULE) {
        const bindings = node.importClause?.namedBindings;
        if (node.importClause?.name || !bindings || !ts.isNamedImports(bindings) || bindings.elements.some((element) => element.name.text !== "encode" || element.propertyName)) errors.push(`${name}: unsupported TOON import`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "encode") encodes++;
      if (ts.isIdentifier(node) && node.text === "encode" && !(ts.isCallExpression(node.parent) && node.parent.expression === node) && !ts.isImportSpecifier(node.parent)) errors.push(`${name}: aliased TOON encoder`);
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (streams > (allowed.streams ?? 0)) errors.push(`${name}: unapproved process stream`);
    if (encodes > (allowed.encodes ?? 0)) errors.push(`${name}: unapproved TOON encode`);
  }
  return errors;
}

function sources(dir, root = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path, root) : path.endsWith(".ts") ? [[relative(root, path), readFileSync(path, "utf8")]] : [];
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = checkOutput(sources(join(dirname(fileURLToPath(import.meta.url)), "../src")));
  if (errors.length) {
    process.stderr.write(`${errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}
