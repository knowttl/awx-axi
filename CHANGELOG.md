# Changelog

## [0.1.9](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.8...awx-axi-v0.1.9) (2026-10-28)


### Bug Fixes

* **docs:** clarify README setup and safety guidance ([#55](https://github.com/knowttl/awx-axi/issues/55)) ([e4cafda](https://github.com/knowttl/awx-axi/commit/e4cafda33eeec00a223f81a1de0884ffcce9f763))
* guide agents through read-only AWX investigations ([#59](https://github.com/knowttl/awx-axi/issues/59)) ([6e2b8f1](https://github.com/knowttl/awx-axi/commit/6e2b8f1b2166f4007a8e88f775f845c238f4e964))

## [0.1.8](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.7...awx-axi-v0.1.8) (2026-10-22)


### Features

* **core:** add bounded pagination and explicit collection completeness ([#50](https://github.com/knowttl/awx-axi/issues/50)) ([c048e52](https://github.com/knowttl/awx-axi/commit/c048e5221e88c082ee72497e6c733dce80cc0d24))
* extend bounded pagination to directory collections ([#52](https://github.com/knowttl/awx-axi/issues/52)) ([5327051](https://github.com/knowttl/awx-axi/commit/532705192e6596dd4ee9dfa1ec0db583834ef8fc))
* extend pagination controls to automation collections ([#51](https://github.com/knowttl/awx-axi/issues/51)) ([6c19452](https://github.com/knowttl/awx-axi/commit/6c19452032935c113dfb1c2562d12e931e29b027))


### Bug Fixes

* improve AWX guidance and secret redaction ([#48](https://github.com/knowttl/awx-axi/issues/48)) ([c8afa07](https://github.com/knowttl/awx-axi/commit/c8afa070d785cb6532186a9c81db915921b9ad5f))
* improve credential lock waiting and refresh AWX documentation ([#53](https://github.com/knowttl/awx-axi/issues/53)) ([ba8c78e](https://github.com/knowttl/awx-axi/commit/ba8c78e981abf54a0c2d2e465bf3becbbf07a444))
* list newest AWX jobs first ([#54](https://github.com/knowttl/awx-axi/issues/54)) ([557837e](https://github.com/knowttl/awx-axi/commit/557837ed9d27c53d1b3f71e9857e23748bd9b44d))

## [0.1.7](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.6...awx-axi-v0.1.7) (2026-10-18)


### Features

* **cli:** add live home dashboard and controller discovery ([#47](https://github.com/knowttl/awx-axi/issues/47)) ([4abd2e9](https://github.com/knowttl/awx-axi/commit/4abd2e96b71c418eabe699b6ea2ce991a94f84b0))


### Bug Fixes

* migrate approval list to --include-decided ([#45](https://github.com/knowttl/awx-axi/issues/45)) ([028a72c](https://github.com/knowttl/awx-axi/commit/028a72c2ea02de87b71e680a11f075ac7126d68d))

## [0.1.6](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.5...awx-axi-v0.1.6) (2026-10-16)


### Features

* hint at skill installation on bare invocation ([#42](https://github.com/knowttl/awx-axi/issues/42)) ([b965f95](https://github.com/knowttl/awx-axi/commit/b965f95282580e14dcdba081aaee3293c2b9e2ce))


### Bug Fixes

* the home view adds one hint line with the exact `npx skills add knowttl/awx-axi --skill awx-axi` command when the detected host has no installed skill, checked per host against that host's documented skill folders; no hint once installed or outside an agent host. ([b965f95](https://github.com/knowttl/awx-axi/commit/b965f95282580e14dcdba081aaee3293c2b9e2ce))

## [0.1.5](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.4...awx-axi-v0.1.5) (2026-10-12)


### Features

* adopt AXI credential profiles and protected PAT storage ([#39](https://github.com/knowttl/awx-axi/issues/39)) ([7c2569e](https://github.com/knowttl/awx-axi/commit/7c2569e85fde6ad02d740a29dc3ecf5d5076e511))
* support explicit per-profile HTTP controller opt-in ([#41](https://github.com/knowttl/awx-axi/issues/41)) ([0b27015](https://github.com/knowttl/awx-axi/commit/0b270152113a0c7e7a8b3fbe6899e33361723106))

## [0.1.4](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.3...awx-axi-v0.1.4) (2026-08-27)


### Features

* **domains:** add group and inventory source inspection ([#36](https://github.com/knowttl/awx-axi/issues/36)) ([7d09cb4](https://github.com/knowttl/awx-axi/commit/7d09cb4ebad12089659126452be37b05ae3f2a8a))
* **domains:** add top-level host inspection ([#34](https://github.com/knowttl/awx-axi/issues/34)) ([f6bd6a8](https://github.com/knowttl/awx-axi/commit/f6bd6a8dfe6c0a675dad42b7115f2f734bd53ab1))
* **schedule:** add prompt-on-launch fields to schedule mutations ([#38](https://github.com/knowttl/awx-axi/issues/38)) ([431675f](https://github.com/knowttl/awx-axi/commit/431675ff87501064d17c06bcd035d3ea3ffadbf7))
* **workflow:** inspect workflow template nodes ([#37](https://github.com/knowttl/awx-axi/issues/37)) ([be48e27](https://github.com/knowttl/awx-axi/commit/be48e275c2827c972761e8474ece25eef00bfe1f))

## [0.1.3](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.2...awx-axi-v0.1.3) (2026-08-24)


### Features

* expand AWX write-management coverage ([#31](https://github.com/knowttl/awx-axi/issues/31)) ([499b2aa](https://github.com/knowttl/awx-axi/commit/499b2aa64213b4c23ed44290109524fe599eba3d))
* **inventory:** support smart inventory filters ([#33](https://github.com/knowttl/awx-axi/issues/33)) ([1589518](https://github.com/knowttl/awx-axi/commit/1589518143a0abe84b5f9e9cbe606e9c06383316))

## [0.1.2](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.1...awx-axi-v0.1.2) (2026-08-11)


### Features

* **core:** implement write transport infrastructure and safety gates ([#21](https://github.com/knowttl/awx-axi/issues/21)) ([870d997](https://github.com/knowttl/awx-axi/commit/870d99790a4fe9c553b61d8aee9d74fc49b655ab))
* **core:** shared core - transport, auth, pagination, and the §4.3 traps ([#3](https://github.com/knowttl/awx-axi/issues/3)) ([ecb61ac](https://github.com/knowttl/awx-axi/commit/ecb61ac87f862c97a11ecd05321d0383f3642893))
* **domains:** add AWX inventory domain and synchronize skill discovery ([#8](https://github.com/knowttl/awx-axi/issues/8)) ([906c75c](https://github.com/knowttl/awx-axi/commit/906c75ca7782a25801989f051fbd8b23231473e0))
* **domains:** add notification, notification-template, and activity-stream domains ([#19](https://github.com/knowttl/awx-axi/issues/19)) ([8cbfefb](https://github.com/knowttl/awx-axi/commit/8cbfefb882d356c1656340685449c943f3d911c6))
* **domains:** add organization credential and user domains ([#13](https://github.com/knowttl/awx-axi/issues/13)) ([8134550](https://github.com/knowttl/awx-axi/commit/81345507fac5ba064bc60bb8e1623b622190ac7b))
* **domains:** add organization, credential, and user domain support ([#14](https://github.com/knowttl/awx-axi/issues/14)) ([6a0e036](https://github.com/knowttl/awx-axi/commit/6a0e0360e4c96b31939707932d80c6c19b24fdf8))
* **domains:** add read-only ad-hoc and project role read surfaces ([#12](https://github.com/knowttl/awx-axi/issues/12)) ([ce50d71](https://github.com/knowttl/awx-axi/commit/ce50d71c753c7cbefd9d8a373774a91d7e2d8b98))
* **domains:** add read-only system job surfaces ([#18](https://github.com/knowttl/awx-axi/issues/18)) ([36884e0](https://github.com/knowttl/awx-axi/commit/36884e00821b1db2076dc387f01294f1fe5c38c5))
* **domains:** add schedule and execution-environment support ([#9](https://github.com/knowttl/awx-axi/issues/9)) ([320ba22](https://github.com/knowttl/awx-axi/commit/320ba2274e40520e80b9f2dfca031b1118d0ce37))
* **domains:** implement Phase 2 Tier 3 deletion and resource mutation subcommands ([#25](https://github.com/knowttl/awx-axi/issues/25)) ([1958fcd](https://github.com/knowttl/awx-axi/commit/1958fcdf51832d4cf065a113e465182f46d57ff9))
* **domains:** implement read-only team and role domains ([#20](https://github.com/knowttl/awx-axi/issues/20)) ([a6d54a5](https://github.com/knowttl/awx-axi/commit/a6d54a5f68849808ac881afbbbb2466b6f28e0ee))
* **domains:** implement write subcommands with mandatory dry-run policy ([#22](https://github.com/knowttl/awx-axi/issues/22)) ([0a40b39](https://github.com/knowttl/awx-axi/commit/0a40b391a4303eef1f2b2a6df63e4e914537c5c9))
* implement job, template, workflow, and project domains ([#5](https://github.com/knowttl/awx-axi/issues/5)) ([c62e3ae](https://github.com/knowttl/awx-axi/commit/c62e3ae10e8a28f6e9d037855d277a1a0fb87eb8))
* scaffold the awx-axi repository and empty CLI shell ([#2](https://github.com/knowttl/awx-axi/issues/2)) ([2dcbc19](https://github.com/knowttl/awx-axi/commit/2dcbc19f378e4b6c1fa3ad522f151f6c2ff2af99))


### Bug Fixes

* **pkg:** add repository metadata and fix bin for provenance publish ([a2ac9e0](https://github.com/knowttl/awx-axi/commit/a2ac9e0800b55d627f0bb6d26cf44e198f430b46))
* **pkg:** add repository metadata and fix bin for provenance publish ([932d1d4](https://github.com/knowttl/awx-axi/commit/932d1d45a215685e2168e4c5f237759392b29853))
* repair skill markdown generation and add inventory constructed-show coverage ([#10](https://github.com/knowttl/awx-axi/issues/10)) ([b58ed7f](https://github.com/knowttl/awx-axi/commit/b58ed7f7bec73094fbee6322986be347fb0d7aa9))
* **skill:** include supported mutations in generated skill ([d6a84c6](https://github.com/knowttl/awx-axi/commit/d6a84c635557d05043af8502d37bd82923b9d3fb))
* **skill:** include supported mutations in generated skill ([f2ee945](https://github.com/knowttl/awx-axi/commit/f2ee9456a1106fc04cb611701f50334f313237f3))

## [0.1.1](https://github.com/knowttl/awx-axi/compare/awx-axi-v0.1.0...awx-axi-v0.1.1) (2026-08-11)


### Features

* **core:** implement write transport infrastructure and safety gates ([#21](https://github.com/knowttl/awx-axi/issues/21)) ([870d997](https://github.com/knowttl/awx-axi/commit/870d99790a4fe9c553b61d8aee9d74fc49b655ab))
* **core:** shared core - transport, auth, pagination, and the §4.3 traps ([#3](https://github.com/knowttl/awx-axi/issues/3)) ([ecb61ac](https://github.com/knowttl/awx-axi/commit/ecb61ac87f862c97a11ecd05321d0383f3642893))
* **domains:** add AWX inventory domain and synchronize skill discovery ([#8](https://github.com/knowttl/awx-axi/issues/8)) ([906c75c](https://github.com/knowttl/awx-axi/commit/906c75ca7782a25801989f051fbd8b23231473e0))
* **domains:** add notification, notification-template, and activity-stream domains ([#19](https://github.com/knowttl/awx-axi/issues/19)) ([8cbfefb](https://github.com/knowttl/awx-axi/commit/8cbfefb882d356c1656340685449c943f3d911c6))
* **domains:** add organization credential and user domains ([#13](https://github.com/knowttl/awx-axi/issues/13)) ([8134550](https://github.com/knowttl/awx-axi/commit/81345507fac5ba064bc60bb8e1623b622190ac7b))
* **domains:** add organization, credential, and user domain support ([#14](https://github.com/knowttl/awx-axi/issues/14)) ([6a0e036](https://github.com/knowttl/awx-axi/commit/6a0e0360e4c96b31939707932d80c6c19b24fdf8))
* **domains:** add read-only ad-hoc and project role read surfaces ([#12](https://github.com/knowttl/awx-axi/issues/12)) ([ce50d71](https://github.com/knowttl/awx-axi/commit/ce50d71c753c7cbefd9d8a373774a91d7e2d8b98))
* **domains:** add read-only system job surfaces ([#18](https://github.com/knowttl/awx-axi/issues/18)) ([36884e0](https://github.com/knowttl/awx-axi/commit/36884e00821b1db2076dc387f01294f1fe5c38c5))
* **domains:** add schedule and execution-environment support ([#9](https://github.com/knowttl/awx-axi/issues/9)) ([320ba22](https://github.com/knowttl/awx-axi/commit/320ba2274e40520e80b9f2dfca031b1118d0ce37))
* **domains:** implement Phase 2 Tier 3 deletion and resource mutation subcommands ([#25](https://github.com/knowttl/awx-axi/issues/25)) ([1958fcd](https://github.com/knowttl/awx-axi/commit/1958fcdf51832d4cf065a113e465182f46d57ff9))
* **domains:** implement read-only team and role domains ([#20](https://github.com/knowttl/awx-axi/issues/20)) ([a6d54a5](https://github.com/knowttl/awx-axi/commit/a6d54a5f68849808ac881afbbbb2466b6f28e0ee))
* **domains:** implement write subcommands with mandatory dry-run policy ([#22](https://github.com/knowttl/awx-axi/issues/22)) ([0a40b39](https://github.com/knowttl/awx-axi/commit/0a40b391a4303eef1f2b2a6df63e4e914537c5c9))
* implement job, template, workflow, and project domains ([#5](https://github.com/knowttl/awx-axi/issues/5)) ([c62e3ae](https://github.com/knowttl/awx-axi/commit/c62e3ae10e8a28f6e9d037855d277a1a0fb87eb8))
* scaffold the awx-axi repository and empty CLI shell ([#2](https://github.com/knowttl/awx-axi/issues/2)) ([2dcbc19](https://github.com/knowttl/awx-axi/commit/2dcbc19f378e4b6c1fa3ad522f151f6c2ff2af99))


### Bug Fixes

* repair skill markdown generation and add inventory constructed-show coverage ([#10](https://github.com/knowttl/awx-axi/issues/10)) ([b58ed7f](https://github.com/knowttl/awx-axi/commit/b58ed7f7bec73094fbee6322986be347fb0d7aa9))
* **skill:** include supported mutations in generated skill ([d6a84c6](https://github.com/knowttl/awx-axi/commit/d6a84c635557d05043af8502d37bd82923b9d3fb))
* **skill:** include supported mutations in generated skill ([f2ee945](https://github.com/knowttl/awx-axi/commit/f2ee9456a1106fc04cb611701f50334f313237f3))
