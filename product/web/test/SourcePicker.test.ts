import test from 'node:test'
import assert from 'node:assert/strict'
import { sourcePickerOptions, type PickableSource } from '../src/sources/sourceOrder'

const src = (id: string, name: string, enabled: boolean, group?: string): PickableSource =>
  ({ id, name, enabled, group })

const LIBRARY: PickableSource[] = [
  src('3', '番茄小说', true, '网文 番茄'),
  src('1', '艾企鹅', false, '停用组'),
  src('2', '笔趣阁', true, '男频'),
  src('4', '书海阁', true),
]

test('sourcePickerOptions - 默认只列启用中的源', () => {
  const options = sourcePickerOptions(LIBRARY)
  assert.deepEqual(options.map(o => o.value), ['2', '3', '4'], '停用的源不能出现在默认列表里')
})

test('sourcePickerOptions - 勾选「含已停用」后停用源排在启用源之后', () => {
  const options = sourcePickerOptions(LIBRARY, true)
  assert.deepEqual(options.map(o => o.value), ['2', '3', '4', '1'], '启用段在前，停用段在后，各自按名字排')
})

test('sourcePickerOptions - 副标题：启用带分组、停用直说搜不到', () => {
  const options = sourcePickerOptions(LIBRARY, true)
  assert.equal(options.find(o => o.value === '3')?.hint, '网文 番茄')
  assert.equal(options.find(o => o.value === '4')?.hint, undefined, '无分组的启用源不给空副标题')
  assert.equal(options.find(o => o.value === '1')?.hint, '已停用，搜不到')
})

test('sourcePickerOptions - 空库不报错', () => {
  assert.deepEqual(sourcePickerOptions([]), [])
  assert.deepEqual(sourcePickerOptions([], true), [])
})
