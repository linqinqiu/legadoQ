## 这个 PR 做了什么

<!-- 一句话说清。关联的 issue 用 "Closes #123"。 -->

## 怎么验证

<!-- 改了行为就写清楚别人怎么复现 / 复跑：命令、点了哪儿、看到什么。贴输出更好。 -->

## 自查

- [ ] `npm run check` 通过
- [ ] `npm test` 通过（或说明了哪条不适用）
- [ ] 改动了框架层（`plugin/` 容器、端点计数、`/api/agent/*` 注册表）还跑了 `gradlew :app:verifyFramework`
- [ ] 行为变了就补 / 改了用例
- [ ] 改了服务端且跑过 `npm run build`（fatJar 能出）
- [ ] 没顺手改无关文件

## 框架契约提醒

- 框架容器 `plugin/` 不得 import 任何具体功能包；端点计数 **139 端点 / 19 组 / AI 自定义接入 8 条** 不得漂。
- 新增端点必须同时登记到 `app/src/main/resources/agent-api.json` 与 `http/` 路由文件，两处由
  `web/test/ApiCatalog.test.ts` 双向核对，少一处判据即红。
- 上述守门由 CI 的 `contract.yml` 在每次 push / PR 自动跑；本地先红比等 CI 红更省事。

## 界面改动

<!-- 有 UI 改动请贴截图 / 录屏，并说明窄屏 / 宽屏各是什么样。没有就删掉这一节。 -->
