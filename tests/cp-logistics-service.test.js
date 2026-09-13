'use strict';

const assert = require('assert');
const {
  CpLogisticsServiceClient,
  TARGET_SHIPPER_NO,
  buildChangePayload,
  cpScheduleDistanceMinutes,
  findDepartmentService,
  getDueCpLogisticsActions,
  mutateServiceRows,
  parseFormSnapshot,
  resetChangedCpScheduleCompletions
} = require('../cp-logistics-service');

function createFixture({ includeTarget = false } = {}) {
  const targetRow = includeTarget ? `
    <tr>
      <td><input name="shipIds" type="hidden" value="${TARGET_SHIPPER_NO}">
          <input name="serviceIds" type="hidden" value="1">
          <input name="isCashOnDeliverys" type="hidden" value="0">
          <input name="isGuarateeValues" type="hidden" value="0">
          <input name="expProductTypes" type="hidden" value=""></td>
      <td><input name="sellerShipNos" type="text" value=""></td>
      <td><input name="agingTypes" type="hidden" value=""></td>
      <td><input name="isAllowModifyWb" type="hidden" value="0"></td>
      <td><input name="scanpayTypes" type="hidden" value="0"></td>
      <td><input name="deliverAgainInfos" type="hidden" value=""></td>
    </tr>` : '';
  return `
    <form id="logisticsServiceAlteration-form">
      <input name="warehouseAddServiceJson" type="hidden" value="">
      <input name="id" type="hidden" value="service-record-1">
      <input name="deptId" type="hidden" value="123456">
      <input name="deptName" type="hidden" value="测试事业部">
      <input name="deptNo" type="hidden" value="CBU123456">
      <select name="serviceId-alter"><option value="">请选择</option><option value="1">仓配一体服务</option></select>
      <select name="shipperOption-alter"><option value="">请选择</option></select>
      <table id="logisticeShipTable-alter"><tbody>
        <tr>
          <td><input name="shipIds" type="hidden" value="CYF-SELF">
              <input name="isGuarateeValues" type="hidden" value="0">
              <input name="isCashOnDeliverys" type="hidden" value="0">
              <input name="expProductTypes" type="hidden" value=""></td>
          <td><input name="serviceIds" type="hidden" value="2"></td>
          <td><input name="sellerShipNos" type="text" value="merchant-carrier"></td>
          <td><input name="agingTypes" type="hidden" value=""></td>
          <td><input name="isAllowModifyWb" type="hidden" value="1"></td>
          <td><input name="scanpayTypes" type="hidden" value="-1"></td>
          <td><input name="deliverAgainInfos" type="hidden" value="keep-this"></td>
        </tr>
        ${targetRow}
      </tbody></table>
      <input name="logisticsServiceNo" type="hidden" value="CLS-1">
      <table id="logisticeTable"><tbody>
        <tr class="logisitics-warehouse-item" data-warehouseno="8001">
          <td><input name="warehouseNos" type="hidden" value="8001"></td>
        </tr>
        <tr class="logisitics-warehouse-item" data-warehouseno="8002">
          <td><input name="warehouseNos" type="hidden" value="8002@3"></td>
          <td><select name="editCooperationModel"><option value="1">寄售</option><option value="3" selected>自有</option></select></td>
        </tr>
      </tbody></table>
      <select name="cloudSorting-alter"><option value="">请选择</option></select>
      <select name="sortingShipperOption"><option value="unselected">请选择</option></select>
      <input name="sAgentCenterList[0].sortingId" type="hidden" value="sorting-1">
      <input name="small_sparePartsStore" type="checkbox" value="1" checked>
      <input name="small_sparePartsStore" type="checkbox" value="2">
      <input name="spStoreBackBigStore" type="radio" value="1" checked>
      <input name="sparePartsStoreWarehouseNos" type="hidden" value="spare-1">
    </form>`;
}

const warehouseServiceMap = {
  warehouseServices: [
    { warehouseNo: '8001', enableServices: ['cold', 'fragile'] },
    { warehouseNo: '8002', enableServices: [] }
  ],
  warehouseServicesTmpl: '[]'
};

const addSnapshot = parseFormSnapshot(createFixture());
assert.deepStrictEqual(addSnapshot.identity, {
  id: 'service-record-1',
  deptId: '123456',
  deptName: '测试事业部',
  deptNo: 'CBU123456',
  logisticsServiceNo: 'CLS-1'
});
assert.deepStrictEqual(addSnapshot.warehouses, [
  { warehouseNo: '8001', cooperationMode: '0' },
  { warehouseNo: '8002', cooperationMode: '3' }
]);

const addPrepared = buildChangePayload(addSnapshot, warehouseServiceMap, 'add');
assert.strictEqual(addPrepared.changed, true);
const addParams = new URLSearchParams(addPrepared.payload);
assert.deepStrictEqual(addParams.getAll('shipIds'), ['CYF-SELF', TARGET_SHIPPER_NO]);
assert.deepStrictEqual(addParams.getAll('serviceIds'), ['2', '1']);
assert.deepStrictEqual(addParams.getAll('warehouseNos'), ['8001@0', '8002@3']);
assert.strictEqual(addParams.get('sellerShipNos'), 'merchant-carrier');
assert.strictEqual(addParams.get('deliverAgainInfos'), 'keep-this');
assert.strictEqual(addParams.get('sAgentCenterList[0].sortingId'), 'sorting-1');
assert.strictEqual(addParams.get('spStoreService'), '1');
assert.deepStrictEqual(JSON.parse(addParams.get('warehouseAddServiceJson')), [
  { warehouseNo: 8001, value: ['cold', 'fragile'] },
  { warehouseNo: 8002, value: null }
]);

const removeSnapshot = parseFormSnapshot(createFixture({ includeTarget: true }));
const removePrepared = buildChangePayload(removeSnapshot, warehouseServiceMap, 'remove');
assert.strictEqual(removePrepared.changed, true);
const removeParams = new URLSearchParams(removePrepared.payload);
assert.deepStrictEqual(removeParams.getAll('shipIds'), ['CYF-SELF']);
assert.deepStrictEqual(removeParams.getAll('serviceIds'), ['2']);
assert.strictEqual(removeParams.get('serviceId-alter'), '');
assert.strictEqual(removeParams.get('shipperOption-alter'), '');

assert.strictEqual(mutateServiceRows(addSnapshot.serviceRows, 'remove').changed, false);
assert.strictEqual(mutateServiceRows(removeSnapshot.serviceRows, 'add').changed, false);

const matched = findDepartmentService([
  { id: 'wrong', deptNo: 'CBU999', deptId: '999', deptName: '其他事业部' },
  { id: 'right', deptNo: 'CBU123456', deptId: '123456', deptName: '测试事业部' }
], { deptNo: 'CBU123456', deptName: '测试事业部' });
assert.strictEqual(matched.id, 'right');

assert.throws(
  () => mutateServiceRows([{ serviceId: '1', shipperNo: 'OTHER', fields: [] }], 'add'),
  /其他仓配一体承运商/
);

const beforeAdd = new Date('2026-09-13T08:59:00+08:00');
const afterAdd = new Date('2026-09-13T09:01:00+08:00');
const normalSchedule = {
  addTime: '09:00',
  removeTime: '18:00',
  activatedAt: '2026-09-12T10:00:00+08:00',
  lastAddDate: '',
  lastRemoveDate: '',
  blockedDate: '',
  blockedAction: ''
};
assert.deepStrictEqual(getDueCpLogisticsActions(normalSchedule, beforeAdd), []);
assert.deepStrictEqual(getDueCpLogisticsActions(normalSchedule, afterAdd).map(item => item.action), ['add']);
assert.deepStrictEqual(getDueCpLogisticsActions({
  ...normalSchedule,
  activatedAt: '2026-09-13T09:00:30+08:00'
}, afterAdd), [], '开启时间晚于当天计划时间时不得立即补跑');
assert.deepStrictEqual(getDueCpLogisticsActions({
  ...normalSchedule,
  lastAddDate: '2026-09-13'
}, afterAdd), [], '当天已经完成的动作不得重复执行');
assert.deepStrictEqual(getDueCpLogisticsActions({
  ...normalSchedule,
  blockedDate: '2026-09-13',
  blockedAction: 'add'
}, afterAdd), [], '当天被阻止的动作不得盲目重试');
assert.strictEqual(cpScheduleDistanceMinutes('23:59', '00:01'), 2);
assert.strictEqual(cpScheduleDistanceMinutes('23:58', '00:01'), 3);
assert.deepStrictEqual(resetChangedCpScheduleCompletions({
  addTime: '00:55',
  removeTime: '19:00',
  lastAddDate: '2026-09-13',
  lastRemoveDate: '2026-09-13'
}, {
  addTime: '01:01',
  removeTime: '19:00'
}), {
  lastAddDate: '',
  lastRemoveDate: '2026-09-13'
}, '修改添加时间时应只重置添加动作的当天完成状态');
assert.deepStrictEqual(resetChangedCpScheduleCompletions({
  addTime: '01:01',
  removeTime: '19:00',
  lastAddDate: '2026-09-13',
  lastRemoveDate: '2026-09-13'
}, {
  addTime: '01:01',
  removeTime: '19:00'
}, true), {
  lastAddDate: '',
  lastRemoveDate: ''
}, '切换固定账号或事业部时应重置两个动作的完成状态');

async function testLiveRequestFlow() {
  let targetExists = false;
  const submitted = [];
  const mockSession = {
    cookies: {
      async get() {
        return [
          { name: 'csrfToken', value: 'csrf-test' },
          { name: 'thor', value: 'thor-test' }
        ];
      }
    },
    async fetch(url, options = {}) {
      const pathname = new URL(url).pathname;
      let responseBody = '';
      if (pathname.endsWith('/queryLogisticsServiceList.do')) {
        responseBody = JSON.stringify({
          aaData: [{ id: 'service-record-1', deptId: '123456', deptNo: 'CBU123456', deptName: '测试事业部' }],
          iTotalDisplayRecords: 1
        });
      } else if (pathname.endsWith('/gotoLogisticsServiceAlterationPage.do')) {
        responseBody = createFixture({ includeTarget: targetExists });
      } else if (pathname.endsWith('/getWarehouseAddService.do')) {
        responseBody = JSON.stringify({ success: 'true', map: warehouseServiceMap });
      } else if (pathname.endsWith('/checkInShipperLine.do')) {
        responseBody = JSON.stringify({ resultCode: 200, resultData: 'false' });
      } else if (pathname.endsWith('/alterationLogisticsService.do')) {
        const params = new URLSearchParams(options.body);
        submitted.push(params);
        targetExists = params.getAll('serviceIds').includes('1')
          && params.getAll('shipIds').includes(TARGET_SHIPPER_NO);
        responseBody = JSON.stringify({ resultCode: 1, resultMessage: '操作成功！', resultData: null });
      } else {
        throw new Error(`未处理的模拟请求：${pathname}`);
      }
      return {
        ok: true,
        status: 200,
        url,
        async text() { return responseBody; }
      };
    }
  };

  const client = new CpLogisticsServiceClient({ session: mockSession, now: () => 123456789 });
  const expectedDepartment = { deptId: '123456', deptNo: 'CBU123456', deptName: '测试事业部' };
  const added = await client.change(expectedDepartment, 'add');
  assert.strictEqual(added.changed, true);
  assert.strictEqual(added.verified, true);
  assert.strictEqual(targetExists, true);
  assert.deepStrictEqual(submitted[0].getAll('serviceIds'), ['2', '1']);
  assert.deepStrictEqual(submitted[0].getAll('warehouseNos'), ['8001@0', '8002@3']);

  const removed = await client.change(expectedDepartment, 'remove');
  assert.strictEqual(removed.changed, true);
  assert.strictEqual(removed.verified, true);
  assert.strictEqual(targetExists, false);
  assert.deepStrictEqual(submitted[1].getAll('serviceIds'), ['2']);
  assert.deepStrictEqual(submitted[1].getAll('shipIds'), ['CYF-SELF']);
  assert.deepStrictEqual(submitted[1].getAll('warehouseNos'), ['8001@0', '8002@3']);
}

async function testCpSessionBootstrap() {
  let initialized = false;
  let bootstrapCount = 0;
  const session = {
    cookies: {
      async get() {
        return initialized
          ? [{ name: 'csrfToken', value: 'cp-csrf' }, { name: 'thor', value: 'thor-test' }]
          : [{ name: 'thor', value: 'thor-test' }];
      }
    },
    async fetch() {
      throw new Error('令牌初始化测试不应发送业务请求');
    }
  };
  const client = new CpLogisticsServiceClient({
    session,
    bootstrapSession: async () => {
      bootstrapCount += 1;
      initialized = true;
    }
  });
  assert.strictEqual(await client.getCsrfToken(), 'cp-csrf');
  assert.strictEqual(bootstrapCount, 1, '缺少CP令牌时应只初始化一次CP会话');
  assert.strictEqual(await client.getCsrfToken(), 'cp-csrf');
  assert.strictEqual(bootstrapCount, 1, '令牌已经存在时不应重复初始化CP会话');
}

Promise.all([testLiveRequestFlow(), testCpSessionBootstrap()])
  .then(() => console.log('CP物流服务动态配置与添加/删除链路测试通过'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
