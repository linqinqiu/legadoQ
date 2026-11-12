/**
 * 端口选择：**默认端口被别的程序占了时，自己往上找一个能用的**。
 *
 * 用户 2026-11-12：「当前固定的 1234 是否不好，应该让其自己找合适的端口」。
 * 直接硬失败（原来的行为）会把「换个软件抢了 1234」变成「阅读器打不开」，
 * 而用户此时最需要的是**能进去**，不是一个端口号。
 *
 * 这里只放纯逻辑：**哪个端口能用由调用方探测**（isFree 回调），
 * 于是判据不用真的 listen，也能把「从 x 开始、最多试 n 个、到 65535 停」钉住。
 *
 * 取舍：
 * - 只往上找，不随机：相邻端口可预测，用户下次手敲地址时容易猜对；
 * - 上限 20 个（可配）：连续 20 个端口都被占，该看的是机器状态，不是继续扫描；
 * - 越过 65535 直接放弃，不绕回低位端口（绕回会命中系统保留段：看起来成功、实际不可绑）。
 */

/** 默认最多往后试几个端口（含首选那个）。 */
export const DEFAULT_SCAN_LIMIT = 20;

/**
 * 从 start 开始往后找一个空闲端口。
 *
 * @param {number} start 首选端口（1..65535）
 * @param {(port: number) => (boolean | Promise<boolean>)} isFree 探测某个端口能否绑定
 * @param {{limit?: number, max?: number}} [options] limit 往后试几个（含首选），max 上限
 * @returns {Promise<number|null>} 找到的端口；一个都没有时 null（不是抛错：
 *   「全都占着」是正常结果，调用方要给它一句人话，而不是一个栈）
 */
export async function pickPort(start, isFree, options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_SCAN_LIMIT;
  const max = Number.isInteger(options.max) && options.max > 0 && options.max <= 65535 ? options.max : 65535;
  if (!Number.isInteger(start) || start < 1 || start > max) {
    throw new RangeError('pickPort: 起始端口应在 1..' + max + '，收到「' + start + '」');
  }
  if (typeof isFree !== 'function') {
    throw new TypeError('pickPort: isFree 必须是函数（端口能不能用由调用方探测）');
  }
  for (let offset = 0; offset < limit; offset += 1) {
    const port = start + offset;
    if (port > max) return null;
    // 探测本身抛错当作「这个端口不能用」：探测失败不该让启动器直接崩。
    let free = false;
    try { free = await isFree(port); } catch { free = false; }
    if (free) return port;
  }
  return null;
}
