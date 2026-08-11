# Changelog

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
