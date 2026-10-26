// 「打开的一本书」= 详情 + 目录 + 可选进度（0.8.2 结构重排从 ReaderScreen.tsx 挪出）：
// 阅读器、详情弹窗、搜索 store、体检、App 外壳都按这个形状传书，定义必须独立于阅读器本体。
import type { BookDetails, Chapter, ReadingProgress } from '../lib/api'

export type OpenBook = { details: BookDetails; bookUrl: string; chapters: Chapter[]; progress?: ReadingProgress }
