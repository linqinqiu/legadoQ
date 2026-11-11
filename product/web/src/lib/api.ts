/** @deprecated 请改用 `lib/api/index.ts` 的按域导出（sources / search / bookshelf / ...）。
 * 本文件只是新入口的别名：旧 `api` 对象、`streamSearch` 与全部类型都在 `lib/api/index.ts` 组装导出。
 * TypeScript 解析 `../lib/api` 时文件优先于同名目录，所以旧调用点的 import 路径不用改。
 */
export * from './api/index'