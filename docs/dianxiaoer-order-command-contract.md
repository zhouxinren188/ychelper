# 店小二调用云仓助手服务契约（第一阶段）

## 1. 职责

云仓助手是第三方异常订单服务，店小二只是接口调用方。

1. 云仓助手桌面端登录后，使用本机机器码连接云仓助手服务器并等待固定指令。
2. 店小二调用云仓助手服务器查询机器码是否在线。
3. 店小二提交机器码、固定操作、订单号和年份。
4. 云仓助手服务器只把指令交给该机器码对应的在线桌面端。
5. 桌面端完成查询或处理，将脱敏结果返回服务器，再由服务器返回店小二。

店小二不部署任务中转服务。双方协议不包含店小二页面、采购单状态或后续业务流程。

## 2. 机器码

机器码默认不存在，只有用户在“其他 → 机器码”点击“生成机器码”后才创建。机器码格式为 `YC-XXXX-XXXX`。

机器码在本机使用以下信息单向派生并按云仓助手账号隔离保存：

- Windows SMBIOS 主板/整机稳定标识；
- Windows `MachineGuid`；
- 当前云仓助手登录账号。

因此同一账号在不同电脑得到不同机器码，同一电脑登录不同账号也得到不同机器码；同一账号再次登录同一电脑时保持不变。原始设备信息和账号原文不上传、不写日志。

店小二的绑定单位是“店小二网店管家主账号体系”。同一主账号及其已授权子账号可以共同使用该主账号绑定的机器码；店小二自行限制无关账号抢占或使用该绑定。

## 3. 当前开放能力

协议保留五个固定命令，但第一阶段只开放前两项：

| 命令 | 状态 | 说明 |
| --- | --- | --- |
| `exception.order.check` | 已开放 | 同时查询 `billexception` 和 `soExceptionCentre` |
| `exception.order.resolve` | 已开放 | 处理最近一次查询确认的全部异常快照 |
| `warehouse.order.check` | 禁用 | 实际接口尚未确认 |
| `warehouse.order.print` | 禁用 | 实际接口尚未确认 |
| `warehouse.order.outbound` | 禁用 | 实际接口尚未确认 |

## 4. 店小二调用接口

接口根路径固定为 `/api/cloud-warehouse/v1`。店小二服务端请求携带由云仓助手签发的固定合作方 API Key：

```http
X-Cloud-Warehouse-Api-Key: <仅保存在双方服务器的凭据>
```

### 4.1 查询机器码在线状态

```http
GET /api/cloud-warehouse/v1/machines/YC-7F3K-92MX/status
```

```json
{
  "machine_code": "YC-7F3K-92MX",
  "online": true,
  "state": "idle",
  "capabilities": {
    "exception.order.check": true,
    "exception.order.resolve": true
  },
  "active_request_id": null,
  "checked_at": "2026-08-13T10:00:00.000Z"
}
```

`state` 固定为 `offline`、`idle` 或 `executing`。在线状态来自桌面端当前等待连接或正在执行的指令，不设置独立心跳接口。

### 4.2 发送指令并等待结果

```http
POST /api/cloud-warehouse/v1/commands
Content-Type: application/json
```

```json
{
  "request_id": "dxr-20260813-000001",
  "machine_code": "YC-7F3K-92MX",
  "command": "exception.order.check",
  "order_no": "3588401003348721",
  "order_year": 2026
}
```

- `request_id`：由店小二为本次具体请求生成；网络重试保持不变，另一次操作必须使用新值。
- `machine_code`：决定由哪台云仓助手处理。
- `order_no + order_year`：决定查询或处理哪张订单。
- 当前只允许两个异常命令，其他命令返回 `capability_unavailable`。
- 同一 `request_id` 携带不同内容时返回 `request_id_collision`。

通常接口等待桌面端执行并直接返回完整结果。执行时间超过 HTTP 等待窗口时返回 `202`，店小二使用下一接口查询结果。

### 4.3 查询指令结果

```http
GET /api/cloud-warehouse/v1/commands/dxr-20260813-000001
```

```json
{
  "request_id": "dxr-20260813-000001",
  "machine_code": "YC-7F3K-92MX",
  "command": "exception.order.check",
  "order_no": "3588401003348721",
  "order_year": 2026,
  "status": "completed",
  "created_at": "2026-08-13T10:00:00.000Z",
  "completed_at": "2026-08-13T10:00:03.000Z",
  "response": {}
}
```

## 5. 异常查询和处理

`exception.order.check` 查询两个固定异常中心。只有两个来源都成功，才能确认没有异常；任一来源失败或结果不完整时返回失败或 `review_required`。

查询发现异常时，桌面端生成十分钟有效的不透明 `exception_snapshot_ref`，绑定：

- 本机机器码；
- 订单号和年份；
- 查询时两个来源的准确异常集合。

店小二调用 `exception.order.resolve` 时仍只提交 `request_id + machine_code + command + order_no + order_year`。云仓助手服务器自动查找同机器码、同订单号、同年份最近十分钟内成功查询得到的快照引用，再下发给桌面端；店小二不需要接触内部异常 ID。

处理前桌面端重新查询并比较异常集合；集合变化则拒绝。处理后再次完整查询两个异常中心，只有两边都成功且已无异常时返回 `succeeded / waiting_arrival`。部分成功、状态矛盾或结果不确定统一返回 `review_required`，禁止自动重复写操作。

## 6. 桌面端内部接口

这些接口只供云仓助手桌面端调用，店小二不调用：

- `POST /api/cloud-warehouse/executor/v1/commands/wait`
- `POST /api/cloud-warehouse/executor/v1/commands/:requestId/result`

桌面端使用当前云仓助手登录会话连接服务器。等待请求本身表示设备在线；服务器交付任务后将设备状态记为 `executing`，收到结果后桌面端立即重新等待。不使用一次性登记码、短期 Token、独立心跳、任务租约、fencing token 或订单映射接口。

服务器下发任务中的路由字段严格为：

```json
{
  "target": {
    "machine_code": "YC-7F3K-92MX"
  },
  "params": {
    "order_no": "3588401003348721",
    "order_year": 2026
  }
}
```

异常处理任务的 `params` 由服务器额外加入本次快照引用。

## 7. 安全边界

- 桌面端只接受 `target.machine_code` 与本机完全一致的任务。
- 只允许固定命令和固定参数；不存在代码、脚本、Shell、动态 URL、模块路径或可执行文件入口。
- Cookie、京东账号、Authorization、Token、密码和接口凭据不进入任务、结果或日志。
- 店小二 API Key 只保存在双方服务器，不出现在桌面端。
- 桌面端保留本地持久幂等收据、订单写锁、写前复验、写后复验和审计。
- 服务器按 `request_id` 持久化指令和结果；重试不会产生新的业务写操作。
