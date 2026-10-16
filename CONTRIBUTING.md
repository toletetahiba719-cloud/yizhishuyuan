# 维护与贡献说明

## 环境与分支

使用 Node.js 22 或 24，建议 24 LTS。`main` 保存可运行版本；修改时建立功能分支，通过 Pull Request 合并。提交信息说明具体变化，例如 `fix: preserve submitted notes on write failure`。

```bash
npm ci --ignore-scripts
npm test
```

## 提交前检查

- 不提交 `data/`、真实密码、QQ 名单、证书私钥或本机设置。
- 行为变更更新 README 或部署教程，涉及数据可靠性时补有意义的回归测试。
- 修改前端后，检查 320px/390px 页面和主要交互；发布前用微信真机测试。
- 修改安装脚本后运行 `bash -n setup.sh` 与 `bash -n setup-https.sh`；实际部署在测试 Ubuntu 主机验收。
- 不在生产实例执行带 `--submit` 的压测。

## 发布与更新

发布前先运行测试，确认数据备份，再按 [部署教程](docs/deployment.md) 上传更新。安装脚本保留已有活动数据与配置。更新后执行只读自检，核对提交、审核公开和导出流程。

可使用 `git archive --format=zip --prefix=yizhishuyuan/ -o 一纸书缘-source.zip HEAD` 生成仅含已跟踪源码的干净打包文件。压缩包不包含 `.git`、活动数据或本地密码。
