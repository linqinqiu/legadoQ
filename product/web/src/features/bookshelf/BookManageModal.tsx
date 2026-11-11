// 书籍管理弹窗：分组 / 换源 / 离线缓存 / 读完标记 / 移出书架，内嵌书籍信息编辑。
// 从 ShelfPage.tsx 拆出（2026-11-12 第 2 批降成本）：组件体逐字未动，import 按导出面补全。
// 调用点只有 ShelfPage（右键菜单「书籍管理」与卡片入口）。

import { useState } from 'react'
import { zh } from '../../i18n/zh'
import { BookCover } from '../../components/Cover'
import { BookGroup, BookshelfItem } from '../../lib/api'
import { Icon } from '../../icons'
import { Select } from '../../components/Select'
import { bookTypeMeta } from '../../lib/bookType'
import { useEscapeClose } from '../../lib/useEscapeClose'
import { BookInfoEditModal } from './BookInfoEditModal'

export function BookManageModal({
  item,
  onClose,
  onSwitchSource,
  onCache,
  onCancelCache,
  onToggleCompleted,
  onUpdateInfo,
  onRemove,
  groups,
  onAssignGroup,
}: {
  item: BookshelfItem
  onClose: () => void
  onSwitchSource: () => void
  onCache: () => void
  onCancelCache: () => void
  onToggleCompleted: () => void
  onUpdateInfo: (updated: BookshelfItem) => void
  onRemove: () => void
  groups: BookGroup[]
  onAssignGroup: (groupId: number) => void
}) {
  const [editingInfo, setEditingInfo] = useState(false)
  useEscapeClose(onClose, editingInfo ? '.book-info-edit-modal' : undefined)
  const isCaching = item.cacheState === 'caching'
  const isReady = item.cacheState === 'ready'
  const isFailed = item.cacheState === 'failed'
  const percent = Math.min(100, Math.round((item.cachedChapters / Math.max(1, item.totalChapters || 1)) * 100))

  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-s book-manage-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`书籍管理: ${item.name}`}>
        <header className="manage-sheet-header">
          <div className="manage-sheet-cover">
            <BookCover coverKey={item.coverKey} name={item.name} author={item.author} compact />
          </div>
          <div className="manage-sheet-info">
            <h3>{item.name}</h3>
            <p>
              {item.author || '未知作者'}
              {bookTypeMeta(item.sourceType) && <span className={`book-type-badge type-${item.sourceType}`}>{bookTypeMeta(item.sourceType)!.label}</span>}
            </p>
            <small>{item.completed ? '已读完' : item.chapterIndex === undefined ? '刚加入书架' : `阅读至第 ${item.chapterIndex + 1} 章`}</small>
          </div>
          <button type="button" className="overlay-close" onClick={onClose} aria-label={zh.common.close}><Icon name="close" /></button>
        </header>

        <div className="manage-sheet-actions">
          <button className="manage-action-row" onClick={() => setEditingInfo(true)}>
            <div className="action-icon"><Icon name="edit" /></div>
            <div className="action-text">
              <strong>编辑书籍信息</strong>
              <small>修改书名、作者或更换封面</small>
            </div>
            <Icon name="arrowRight" />
          </button>

          <div className="manage-group-box">
            <div className="manage-group-box-head">
              <div className="action-icon"><Icon name="folder" /></div>
              <div className="action-text">
                <strong>分组</strong>
                <small>{groups.find(group => group.id === (item.groupId ?? 0))?.name ?? '未分组'}</small>
              </div>
            </div>
            {/*
              这里原来是把**全部**分组摊成一排胶囊：十几个分组时还行，"分组一大堆"（用户 2026-09-30
              问的就是这个）就变成一堵墙，而且右键菜单那条「更多分组…」正是落到这里，等于把问题搬了个家。
              换成站内 Select：能按名字过滤、每条带本数，规模再大也只有一个控件的高度。
            */}
            <Select
              className="manage-group-select"
              ariaLabel="这本书的分组"
              searchable
              value={String(item.groupId ?? 0)}
              onChange={value => onAssignGroup(Number(value))}
              options={[
                { value: '0', label: '未分组' },
                ...groups.map(group => ({ value: String(group.id), label: group.name, hint: `${group.bookCount} 本` })),
              ]}
            />
          </div>

          {item.sourceId !== 'loc_book' && (
            <button className="manage-action-row" onClick={() => { onClose(); onSwitchSource() }}>
              <div className="action-icon"><Icon name="sliders" /></div>
              <div className="action-text">
                <strong>切换书源</strong>
                <small>{item.alternateSources?.length ? `已有 ${item.alternateSources.length} 个备选书源，可全网检索` : '在其他书源中搜索匹配并无缝替换'}</small>
              </div>
              <Icon name="arrowRight" />
            </button>
          )}

          {isCaching ? (
            <div className="manage-cache-box">
              <div className="manage-cache-info-row">
                <div className="action-icon"><Icon name="download" /></div>
                <div className="action-text">
                  <strong>正在离线缓存全本</strong>
                  <small>{percent}% ({item.cachedChapters} / {item.totalChapters || '?'}) 章</small>
                </div>
                <button className="subtle-button cancel-cache-link" onClick={onCancelCache}>取消缓存</button>
              </div>
              <div className="manage-cache-bar-track">
                <div className="manage-cache-bar-fill" style={{ width: `${percent}%` }} />
              </div>
            </div>
          ) : (
            <button className="manage-action-row" onClick={() => onCache()}>
              <div className="action-icon"><Icon name="download" /></div>
              <div className="action-text">
                <strong>{isReady ? '重新缓存 / 校验全本' : isFailed ? '重试离线缓存' : '离线缓存全本'}</strong>
                <small>{isReady ? `已离线缓存 ${item.cachedChapters} 章` : isFailed ? (item.cacheError || '部分章节未缓存，点击重试') : '预先下载全书正文以供离线阅读'}</small>
              </div>
              <Icon name="arrowRight" />
            </button>
          )}

          <button className="manage-action-row" onClick={() => { onClose(); onToggleCompleted() }}>
            <div className="action-icon"><Icon name="check" /></div>
            <div className="action-text">
              <strong>{item.completed ? '恢复为正在阅读' : '标记为已读完'}</strong>
              <small>{item.completed ? '移回「正在阅读」分组' : '移至「已读完」分组'}</small>
            </div>
            <Icon name="arrowRight" />
          </button>

          <button className="manage-action-row danger" onClick={() => { onClose(); onRemove() }}>
            <div className="action-icon"><Icon name="close" /></div>
            <div className="action-text">
              <strong>移出书架</strong>
              <small>清除阅读进度与离线缓存</small>
            </div>
            <Icon name="arrowRight" />
          </button>
        </div>
      </div>

      {editingInfo && (
        <BookInfoEditModal
          item={item}
          onSaved={updated => {
            onUpdateInfo(updated)
          }}
          onClose={() => setEditingInfo(false)}
        />
      )}
    </div>
  )
}