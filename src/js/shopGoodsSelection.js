'use strict';

(function exposeShopGoodsSelection(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.shopGoodsSelection = api;
})(typeof window !== 'undefined' ? window : globalThis, function createShopGoodsSelection() {
  function groupGoodsByProduct(goods) {
    const groups = [];
    const groupMap = new Map();
    (Array.isArray(goods) ? goods : []).forEach((item, index) => {
      const productCode = String(item && item.productCode || '').trim();
      const key = productCode || `__missing_product_${index}`;
      if (!groupMap.has(key)) {
        const group = [];
        groupMap.set(key, group);
        groups.push(group);
      }
      groupMap.get(key).push(item);
    });
    return groups;
  }

  function pickRandomItems(items, count, random = Math.random) {
    if (items.length <= count) return items.slice();
    const indexes = items.map((item, index) => index);
    for (let index = indexes.length - 1; index > 0; index--) {
      const randomIndex = Math.floor(random() * (index + 1));
      [indexes[index], indexes[randomIndex]] = [indexes[randomIndex], indexes[index]];
    }
    return indexes
      .slice(0, count)
      .sort((a, b) => a - b)
      .map(index => items[index]);
  }

  function pickPricedItem(items, direction) {
    const priced = items.filter(item =>
      item && item.price != null && item.price !== '' && Number.isFinite(Number(item.price))
    );
    if (priced.length === 0) return items[0] ? [items[0]] : [];
    const selected = priced.reduce((current, item) => {
      const currentPrice = Number(current.price);
      const itemPrice = Number(item.price);
      return direction === 'min'
        ? (itemPrice < currentPrice ? item : current)
        : (itemPrice > currentPrice ? item : current);
    });
    return [selected];
  }

  function selectGoodsPerProduct(goods, mode = '全部', count = 10, random = Math.random) {
    const normalizedCount = Math.max(1, Number.parseInt(count, 10) || 10);
    const selected = [];
    for (const group of groupGoodsByProduct(goods)) {
      switch (mode) {
        case '第1个':
          selected.push(group[0]);
          break;
        case '最后1个':
          selected.push(group[group.length - 1]);
          break;
        case '最低价':
          selected.push(...pickPricedItem(group, 'min'));
          break;
        case '最高价':
          selected.push(...pickPricedItem(group, 'max'));
          break;
        case '前N个':
          selected.push(...group.slice(0, normalizedCount));
          break;
        case 'N个':
          selected.push(...pickRandomItems(group, normalizedCount, random));
          break;
        default:
          selected.push(...group);
          break;
      }
    }
    return selected.filter(Boolean);
  }

  function collectUniqueSkuValues(goods, indexes) {
    const source = Array.isArray(goods) ? goods : [];
    const selectedIndexes = Array.isArray(indexes) ? indexes : [];
    const seen = new Set();
    const skus = [];
    for (const rawIndex of selectedIndexes) {
      const index = Number.parseInt(rawIndex, 10);
      const sku = String(source[index] && source[index].sku || '').trim();
      if (!sku || seen.has(sku)) continue;
      seen.add(sku);
      skus.push(sku);
    }
    return skus;
  }

  function removeGoodsByTarget(goods, target = {}) {
    const source = Array.isArray(goods) ? goods : [];
    const targetItem = target.item;
    if (!targetItem || (target.type !== 'spu' && target.type !== 'sku')) {
      return source.slice();
    }

    if (target.type === 'spu') {
      const productCode = String(targetItem.productCode || '').trim();
      if (productCode) {
        return source.filter(item => String(item && item.productCode || '').trim() !== productCode);
      }
      return source.filter(item => item !== targetItem);
    }

    const sku = String(targetItem.sku || '').trim();
    return source.filter(item => {
      if (item === targetItem) return false;
      return !sku || String(item && item.sku || '').trim() !== sku;
    });
  }

  return { collectUniqueSkuValues, groupGoodsByProduct, removeGoodsByTarget, selectGoodsPerProduct };
});
