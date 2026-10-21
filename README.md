# dsh-conversation-delete

为 DeepSeek Harness（DSH）Web 界面的会话菜单增加永久删除功能。

**作者：[jiugeovo](https://github.com/jiugeovo)**  
插件包名：`@local/dsh-conversation-delete` · 版本：`1.0.0`

## 功能

- 在侧栏会话菜单中增加删除入口，并显示确认对话框。
- 删除会话日志、关联的子代理会话、派生缓存及工作区引用。
- 清理置顶和归档引用，通知已连接的界面移除会话。
- 会话存在正在运行的工作时拒绝删除。
- 要求已认证的 owner 身份及同源请求。
- 共享附件保留，避免破坏其他会话引用的同一附件。
- 包含中文、英文界面文案。

删除会永久移除目标会话的日志，并非归档。操作前会弹出确认框。

## 兼容版本

已在 `@deepseek-ai/dsh@0.2.1-rc.2`、Node.js 22 环境验证。
插件依赖 DSH 的 Host/Client 插件服务接口；升级 DSH 后应重新验证兼容性。

## 安装

在运行 DSH 的用户环境下操作，使用原有的 `DSH_HOME`，不要另建空的账号配置目录。
下面路径仅为示例，应替换为自己的 DSH home：

```bash
export DSH_HOME=/path/to/your/dsh-home
git clone https://github.com/jiugeovo/dsh-conversation-delete.git "$DSH_HOME/profiles/conversation-delete"
dsh plugin --profile web add link:../conversation-delete
```

在 `$DSH_HOME/profiles/web/package.json` 中，向已有的 `dsh.profile.bundles` 数组追加：

```json
"@local/dsh-conversation-delete"
```

保留数组中的其他插件。该包的 `dsh.bundle.patch` 会加载 `cordis.patch.yml`，注册服务端插件；
`dsh.client` 声明会加载 Web 客户端组件。完成后重启原有 DSH Web 进程。
如果使用名为 `dsharness` 的 systemd 服务：

```bash
sudo systemctl restart dsharness
```

## 使用

打开 Web 界面，在目标会话的菜单中选择删除，再确认。
如果提示会话正在运行，请先结束对应工作，再重新尝试。

## 测试

测试仅使用临时日志目录及模拟上下文，不连接真实会话存储：

```bash
npm test
```

测试结果：8 项测试全部通过。

## 文件

- `index.js`：Host 端鉴权、运行状态检查、日志及引用清理。
- `client.js`：Web 菜单入口、确认对话框与请求处理。
- `cordis.patch.yml`：插件注册声明。
- `locale/`、`icon.svg`：界面文案和图标。
- `tests/`：Host 与 Client 的隔离测试。
- `dist/dsh-conversation-delete-1.0.0.zip`：包含源码、文档和测试的完整归档。
- `SHA256SUMS`：源码文件校验清单。
