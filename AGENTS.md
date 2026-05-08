# AGENTS.md - AI 开发规范备忘

## 热更新发布规范

1. **全量包发布**：每次热更新必须打全量包（包含所有运行时源文件），禁止只打增量包。用户可能从任意旧版本直接跳到最新版，增量包会导致中间版本文件丢失。

2. **全量包内容**：main.js、preload.js、package.json、src/ 下所有文件（排除 icon.png 和 icon.ico）。

3. **发布方式自动评估**（每次发布前必须自行判断，不要问用户）：
   - 只改源代码文件 → 热更新全量包
   - 新增了 npm 依赖（dependencies 有变化） → 必须用 electron-builder 重新打安装包（热更新无法分发 node_modules）

4. **ZIP 目录结构**：必须保持与应用根目录一致（如 src/css/style.css、src/js/renderer.js），解压后直接覆盖应用安装目录。

## 服务器部署信息

- SSH: `ssh -o BatchMode=yes Administrator@150.158.54.108`
- SCP: `scp -o BatchMode=yes <local> Administrator@150.158.54.108:"<remote>"`
- 服务器项目路径: `C:\ychelper-server`
- PM2 进程名: `ychelper`
- 管理后台密码: `admin123456`
- 上传热更新: `curl -s -X POST -H "x-admin-password: admin123456" -F "version=X.X.X" -F "changelog=..." -F "file=@update-X.X.X.zip" http://150.158.54.108:3000/api/update/upload`
