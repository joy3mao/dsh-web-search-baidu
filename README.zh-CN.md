# dsh-web-search-baidu

<div align="center">

[🇺🇸 **English**](README.md) ・ [🇨🇳 **中文**](README.zh-CN.md)

</div>

---

面向 dsh web 接缝（`ctx.web`）的百度千帆网页搜索 Provider。在稳定 id `baidu`
下注册一个 `WebSearchProvider`，调用百度的 AI 搜索接口，使内置的 `web_search`
工具（由 `standard` agent 预设通过 `@deepseek-ai/dsh-tool-web` 挂载）改走百度
而不是 DeepSeek 通道——当 `DEEPSEEK_API_KEY` 未配置或默认 Provider 不可用时，
作为即插即用的替代方案。

## 为什么做 Provider，而不是新工具

web 接缝（`@deepseek-ai/dsh-web`）负责 Provider 选择、错误映射、取消以及
`maxResults` 上限。注册搜索 Provider 可以复用整条既有管线——`web_search` 工具
的 schema、提示词指导、`kind: search` 卡片和时间策略，模型侧零改动。模型仍然
调用 `web_search`，只是后端变了。

## 安装

本包是一个纯 ESM npm 包（无构建步骤），可通过插件命令安装到任意 dsh profile
——支持本地目录或 git 仓库两种来源。

```sh
# 本地目录（相对或绝对路径）：
dsh plugin --profile web add file:/path/to/dsh-web-search-baidu
```
或
```sh
# 从 git 仓库安装：
dsh plugin --profile web add git:joy3mao/dsh-web-search-baidu.git
```

`dsh plugin ... add` 在 profile 目录里转发给 pnpm；本包声明了精确锁定版本
（exact-pinned）的 `@deepseek-ai/*` 依赖，全新 profile 会自动拉取（没有
`prepare` 脚本，因此无需 `allowBuilds` 条目——未来版本若加入构建步骤则需要）。
更新方式：目录依赖重新执行 `add`，git 依赖执行
`dsh plugin --profile web update dsh-web-search-baidu`。

## 接线（Wiring）

安装后，在 profile 的 `cordis.patch.yml` 中按包名引用（本包不附带 bundle）：

```yaml
# 让内置 web_search 工具走百度 AI 搜索。
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: baidu

- insert:
    - id: web-search-baidu
      name: 'dsh-web-search-baidu'
      config: {apiKey: xxx}
```

`web` 这一行会整体替换基础行的整个 `config`（loader patch 语义），所以需要
重新写明 `searchProvider`。基础 bundle 里的 `web-search-deepseek` 行仍保持注册
但未选中；想切回时把 `searchProvider` 设为 `deepseek-official` 即可。

## 配置

所有字段均可选；默认值见下表。可在插件设置面板中热更新（namespace
`web-search-baidu`）。

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `apiKey` | string (secret) | — | 字面量百度千帆 API key；优先于环境变量引用。 |
| `apiKeyEnv` | string (credential-ref) | `BAIDU_QIANFAN_API_KEY` | 每次搜索时解析的环境变量或凭据服务引用。 |
| `baseURL` | string | `https://qianfan.baidubce.com/v2/ai_search/web_search` | AI 搜索接口地址（不追加路径）。 |
| `searchSource` | string | `baidu_search_v2` | `search_source` 载荷值。 |
| `resourceTypes` | `{ type, top_k? }[]` | `[{ type: 'web', top_k: 20 }]` | `resource_type_filter` 载荷条目。 |
| `searchRecencyFilter` | string | `year` | `search_recency_filter` 载荷值；空字符串则省略该字段。 |

百度 API key 的解析顺序：先凭据服务，再启动环境（`launchEnvironmentOf`），最后
直接使用字面量 `apiKey` 配置。建议优先使用环境变量，避免密钥进入配置文件。

## 服务 API 与事件

- 通过 `registerSearchProvider` 在 `ctx.web` 上注册 `WebSearchProvider`（id
  `baidu`）；返回的 disposer 会在插件卸载时注销。本包不提供任何 service。
- 每次请求前在当前发起者的会话上发出会话事件
  `web/baidu-search-request`（无密钥的接口地址和精确请求体），与
  `@deepseek-ai/dsh-web-search-deepseek` 的
  `web/deepseek-search-llm-request` 对应。事件以信封的 `ignorable` 标记追加，
  因为其类型是插件私有：不认识它的 harness 构建（例如更新后）会跳过这条记录，
  而不是拒绝加载整个会话日志。该请求纯属信息性——重建只需要周围的
  `tool/call` / `tool/result` 事件。
- 错误是带稳定错误码的 `WebError`：`WEB_PROVIDER_CREDENTIAL_MISSING`、
  `WEB_PROVIDER_ERROR`、`WEB_ABORTED`。

## 设计要点

- `available()` 是廉价本地检查（key 可解析且 `baseURL` 可解析），绝不发起网络
  请求；接缝在调用时做 Provider 选择。
- 线上格式是 Provider 私有的，不使用 `ctx.llm`：纯 `fetch` POST，携带
  `Authorization: Bearer <key>` 和百度 `ai_search/web_search` 接口的精确载荷
  （含查询的 `messages`、`search_source`、`resource_type_filter`、
  `search_recency_filter`）。
- `mapBaiduResponse` 遍历 `references[]`（`title`/`content`/`url`），按 URL
  去重，并把非空的顶层 `answer` 字符串提升为结果的 `content`。空 references
  映射为空结果（工具渲染为 “No results found.”）而不是报错。

## 模型体验

### 通过 `web_search` 工具的网页搜索

#### 模型看到什么

本包不修改任何提示词文本，也不注册新工具。模型看到的 `web_search` 工具与
`@deepseek-ai/dsh-tool-web` 定义的完全一致（`query` 参数；渲染带标题、摘要和
URL 的来源）。只有应答的后端变了：结果现在来自百度 AI 搜索。由于百度不返回
`publishedAt`，来源只携带 `url`、`title` 和 `snippet`。

#### Token 影响

按调用条件产生：标准的 `web_search` 结果由接缝限制到 `searchMaxResults`（默认
8）条来源，与 DeepSeek 通道一致。不增删任何提示词或 schema token。

#### KV Cache 影响

不会失效：工具目录与系统提示词与 DeepSeek 通道组合逐字节一致，已有的可复用
请求前缀保持可复用。本包唯一带来的变化是 Provider 选择配置
（`web.searchProvider`），它影响的是执行期路由，而非提示词前缀。

## 已知限制与待办

- **已实测**——用生产 API key 对百度千帆接口真实跑过一次 `ctx.web.search()`，
  约 2 秒返回映射后的来源；请求路径另用 stub `fetch` 做了单元验证
  （`verify/baidu-search.mjs`）和接缝验证（`verify/baidu-search-seam.mjs`）。
- **仅百度摘要**——`references[].content` 作为摘要；百度响应不含发布日期，
  因此 `publishedAt` 永远不设置。
- **无 fetch 后端**——本包只提供搜索。`web_fetch` 在本部署中保持禁用
  （`tool-web` 行，`fetch: false`），与基础组合一致。
- **Provider 固定，而非自动回退**——web 接缝刻意没有静默回退链：部署必须显式
  固定 `searchProvider: baidu`（或 `deepseek-official`）。这里的“回退”是指
  配置层面的、对未配置默认 Provider 的替代。
- **纯 ESM + JSDoc，无 tsdown 构建**——保持免构建，`dsh plugin ... add` 可从
  目录或 git 直接安装。未来迁入 deepseek-harness 仓库
  （`packages/<group>/dsh-web-search-baidu`）时，会增加 tsdown 构建、类型声明
  面与仓库的测试门禁。
