import { useState, useEffect, useRef, useMemo } from 'react'
import { api, type SourceSummary } from '../lib/api'
import { buildGroupingPlan, HEALTH_TAGS, type HealthTier } from './sourceGrouping'
import { dropHealthResults, getHealthRun, startHealthRun, stopHealthRun, useHealthRun } from './sourceHealthRun'
import { Icon } from '../icons'
import { useEscapeClose } from '../lib/useEscapeClose'

interface SourceHealthModalProps {
  sources: SourceSummary[]
  /** 清单到没到手：`sources` 空数组既可能是"还在路上"也可能是"库里真没有"，界面不能都写成 0。 */
  sourcesState: 'loading' | 'ready' | 'failed'
  onClose: () => void
  onSourcesChange: () => void
  onToast: (message: string, type?: 'info' | 'success' | 'error') => void
}

/**
 * 体检结论分档。只有「确认可用性有问题」的四类允许被一键停用/删除；
 * empty / blocked / needs_login / needs_webview 是「我们这边差能力或差登录」，
 * 把它们一起关掉就是上一轮把整库 4,874 个源停成 2 个的那种事故。
 */
export const HEALTH_LABELS: Record<string, string> = {
  valid: '正常', slow: '迟缓', empty: '零结果', blocked: '访问受限', needs_login: '需登录',
  needs_webview: '需渲染JS', unreachable: '连不上', tls: '证书问题', broken: '规则失效', invalid: '结构错误',
  // 这两类是"这个源在本服务里做不了搜索"，不是"这个站连不上"：服务端一个请求都没发（见 SourceHealth.probe）
  explore_only: '仅发现', no_search: '未配搜索',
}
const DEAD_STATES = ['unreachable', 'tls', 'broken', 'invalid']
const PENDING_STATES = ['empty', 'blocked', 'needs_login', 'needs_webview']
const UNCONFIGURED_STATES = ['explore_only', 'no_search']
const isDead = (state: string) => DEAD_STATES.includes(state)
const isPending = (state: string) => PENDING_STATES.includes(state)
const isUnconfigured = (state: string) => UNCONFIGURED_STATES.includes(state)

type TabFilter = 'all' | 'valid' | 'slow' | 'pending' | 'unconfigured' | 'dead'

export function SourceHealthModal({
  sources,
  sourcesState,
  onClose,
  onSourcesChange,
  onToast,
}: SourceHealthModalProps) {
  /**
   * 运行状态住在 `sourceHealthRun.ts`，这里只是订阅者（用户 2026-10-02：
   * 「除非点击了关闭，其他情况都后台持续体检一直到结束」）。
   * 原来这个循环挂在组件里：关窗、换页、开别的对话框都会卸载组件并把 `cancelledRef` 置位，
   * 于是几十分钟的整库体检只要点一下别的地方就静默作废。
   */
  const run = useHealthRun()
  const running = run.running
  const progress = { total: run.total, checked: run.checked }
  const durationMs = run.durationMs
  const results = run.results
  const [activeTab, setActiveTab] = useState<TabFilter>('all')
  const [filterQuery, setFilterQuery] = useState('')
  const [busyAction, setBusyAction] = useState<string | null>(null)

  /**
   * 体检范围。默认只圈启用中的源：这台库 5,574 个全启用时一次整库体检要几十分钟，
   * 而停用的那批用户根本不读，探它们只是在结果里堆「连不上」并淹掉真正要看的那几十个。
   * 想连停用的一起看要显式勾，勾完是明确的用户动作，不是我们替他决定。
   */
  const [includeDisabled, setIncludeDisabled] = useState(false)
  const scoped = useMemo(
    () => (includeDisabled ? sources : sources.filter(source => source.enabled)),
    [sources, includeDisabled],
  )
  const disabledCount = sources.length - sources.filter(source => source.enabled).length

  const stats = useMemo(() => {
    let valid = 0
    let slow = 0
    let pending = 0
    let unconfigured = 0
    let dead = 0
    for (const r of results) {
      if (r.statusCategory === 'valid') valid++
      else if (r.statusCategory === 'slow') slow++
      else if (isDead(r.statusCategory)) dead++
      else if (isUnconfigured(r.statusCategory)) unconfigured++
      else pending++
    }
    return { total: results.length, valid, slow, pending, unconfigured, dead }
  }, [results])

  const filteredResults = useMemo(() => {
    return results.filter(item => {
      if (activeTab === 'valid' && item.statusCategory !== 'valid') return false
      if (activeTab === 'slow' && item.statusCategory !== 'slow') return false
      if (activeTab === 'dead' && !isDead(item.statusCategory)) return false
      if (activeTab === 'pending' && !isPending(item.statusCategory)) return false
      if (activeTab === 'unconfigured' && !isUnconfigured(item.statusCategory)) return false
      if (filterQuery) {
        const q = filterQuery.toLowerCase()
        return item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)
      }
      return true
    })
  }, [results, activeTab, filterQuery])

  const startCheck = (targetIds?: string[]) => {
    const idsToCheck = targetIds ?? scoped.map(source => source.id)
    if (idsToCheck.length === 0) {
      onToast('没有可检测的书源', 'info')
      return
    }
    // 一次 POST 打整库时，服务端要全部探完才回，进度条只能作假；
    // 按批发送就能每批落地一次：条子是真走完的，结果也是一条条冒出来的，
    // 分组标签也就能在**过程中**跟着打上，而不是跑完再让用户去点按钮。
    startHealthRun({
      ids: idsToCheck,
      previous: run.results,
      groupsOf: () => Object.fromEntries(sources.map(source => [source.id, source.group ?? ''])),
      onSourcesChange,
      onToast,
    })
  }

  /**
   * 显式停止 —— 这是唯一能提前结束一轮体检的入口。
   * 收起窗口、切到别的页面都**不**算停止：一轮整库体检几十分钟，
   * 以前顺手点一下别的地方就静默作废，那是用户说的「后台持续体检一直到结束」（2026-10-02）。
   */
  const stopCheck = () => {
    stopHealthRun()
    onToast(`已停止体检：完成 ${progress.checked} / ${progress.total}，已出的结论都留着了`, 'info')
  }

  /**
   * 打开弹窗不再无条件自动开跑。
   *
   * 以前是 `useEffect(() => void startCheck(), [])` —— 一开就对着整库外呼。
   * 本机 5,574 个源全启用时那是 44 批 × 每批最多 40 秒，几十分钟起步，
   * 而且用户只是点开想看上次体检的结果，就被迫发起了一轮新扫描（「过慢」的一半成因）。
   * 小规模（默认范围 ≤ AUTO_CHECK_LIMIT 个）仍然自动开跑，保持"点开就有结论"的手感；
   * 超过就要显式按一次「开始体检」，让发起动作回到用户手里。
   * 卸载时**不**再取消：那一轮如果还在跑，它继续在后台跑完。
   */
  const AUTO_CHECK_LIMIT = 300
  useEffect(() => {
    if (!getHealthRun().running && scoped.length > 0 && scoped.length <= AUTO_CHECK_LIMIT) startCheck()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 体检结论 → 分组标签。只追加/摘掉我们自己的标签，用户与作者写的分类原样保留。 */
  const groupingPlans = useMemo(() => {
    const currentGroups: Record<string, string> = {}
    for (const source of sources) currentGroups[source.id] = source.group ?? ''
    return buildGroupingPlan(
      results.map(item => ({ id: item.id, name: item.name, statusCategory: item.statusCategory, latencyMs: item.latencyMs })),
      currentGroups,
    )
  }, [results, sources])

  const applyTier = async (tier: HealthTier, ids: string[]) => {
    setBusyAction(`tag:${tier}`)
    try {
      const resp = await api.batchSources('tag_group', ids, HEALTH_TAGS[tier])
      onToast(resp.message || `已为 ${resp.affected} 个书源加上「${HEALTH_TAGS[tier]}」`, 'success')
      onSourcesChange()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '打标签失败', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const removeTier = async (tier: HealthTier, ids: string[]) => {
    setBusyAction(`untag:${tier}`)
    try {
      const resp = await api.batchSources('untag_group', ids, HEALTH_TAGS[tier])
      onToast(resp.message || `已摘掉 ${resp.affected} 个书源的「${HEALTH_TAGS[tier]}」`, 'success')
      onSourcesChange()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '撤销标签失败', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleBatchDisableFailed = async () => {
    const failedItems = results.filter(r => isDead(r.statusCategory))
    if (failedItems.length === 0) {
      onToast('当前无失效书源需要停用', 'info')
      return
    }
    setBusyAction('disable_failed')
    try {
      const resp = await api.batchSources('disable', failedItems.map(i => i.id))
      onToast(resp.message || `已停用 ${resp.affected} 个失效书源`, 'success')
      onSourcesChange()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '停用失败', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleBatchDeleteFailed = async () => {
    const failedItems = results.filter(r => isDead(r.statusCategory))
    if (failedItems.length === 0) {
      onToast('当前无失效书源需要删除', 'info')
      return
    }
    const names = failedItems.slice(0, 3).map(i => i.name).join('、') + (failedItems.length > 3 ? ` 等共 ${failedItems.length} 个` : '')
    if (!confirm(`确定要彻底删除以下 ${failedItems.length} 个失效书源吗？\n（${names}）\n删除后不可恢复！`)) {
      return
    }
    setBusyAction('delete_failed')
    try {
      const resp = await api.batchSources('delete', failedItems.map(i => i.id))
      onToast(resp.message || `已删除 ${resp.affected} 个失效书源`, 'success')
      dropHealthResults(failedItems.map(item => item.id))
      onSourcesChange()
    } catch (err) {
      onToast(err instanceof Error ? err.message : '删除失败', 'error')
    } finally {
      setBusyAction(null)
    }
  }

  const handleRetryFailed = () => {
    const failedIds = results
      .filter(r => isDead(r.statusCategory))
      .map(r => r.id)
    if (failedIds.length === 0) {
      onToast('没有失效书源需要重试', 'info')
      return
    }
    void startCheck(failedIds)
  }

  const handleRetrySingle = (id: string) => {
    void startCheck([id])
  }

  useEscapeClose(onClose)
  return (
    <div className="overlay-backdrop" onClick={onClose}>
      <div className="dialog-shell size-m source-health-modal" role="dialog" aria-modal="true" aria-label="书源体检" onClick={e => e.stopPropagation()}>
        <header className="dialog-head">
          <div className="health-modal-title">
            <Icon name="activity" />
            <div>
              <h2>书源连通性与健康体检</h2>
              <small>
                {running
                  ? `正在并发探测「${includeDisabled ? '全部' : '启用中'}」的 ${progress.total} 个书源：已检测 ${progress.checked}（${(durationMs / 1000).toFixed(1)}s）`
                    + (run.autoTagged > 0 ? ` · 过程中已给 ${run.autoTagged} 个不能正常使用的打上体检标签` : '')
                    + ' · 收起窗口不会打断，只有「停止体检」会'
                  : stats.total === 0
                    ? sourcesState === 'loading'
                      ? '书源清单还在取：取回来才知道这一次要探测多少个，先稍等'
                      : sourcesState === 'failed'
                        ? '书源清单没取到：关掉这个窗口，回书源页看那句错误，别在这里等体检'
                        : `还没开始：下面那一次会探测「${includeDisabled ? '全部' : '启用中'}」的 ${scoped.length} 个书源，中途可以停`
                    : `本轮检测 ${stats.total} 个书源 · 用时 ${(durationMs / 1000).toFixed(1)}s`}
              </small>
            </div>
          </div>
          <div className="health-modal-actions">
            {running && (
              // 以前这里只有一个小叉：体检一开就是整库几十分钟，想停只能关窗重开
              <button type="button" className="subtle-button health-stop-btn" onClick={stopCheck}>
                停止体检
              </button>
            )}
            {disabledCount > 0 && (
              <label className="health-scope-toggle" title="停用的书源默认不探：它们不参与搜索，探了只会堆「连不上」">
                <input
                  type="checkbox"
                  checked={includeDisabled}
                  disabled={running}
                  onChange={event => setIncludeDisabled(event.target.checked)}
                />
                {/*
                  勾选**只改范围，不发起扫描**。以前这里跟着一次 startCheck()，
                  于是"手滑勾一下"就对着 5,574 个源开了一轮几十分钟的扫描（还会顺手打标签）。
                  扫描的发起动作归下面那颗「开始体检」，它的括号里实时写着会探多少个。
                */}
                连停用的一起体检（{disabledCount}）
              </label>
            )}
            {/* 收起 ≠ 停止：一轮整库体检几十分钟，顺手点叉就作废是用户明确要改掉的（2026-10-02） */}
            <button type="button" className="overlay-close" onClick={onClose}
              aria-label={running ? '收起窗口（体检继续在后台跑）' : '关闭'}>
              <Icon name="close" />
            </button>
          </div>
        </header>

        {/* Progress bar */}
        <div
          className="health-progress-wrap"
          role="progressbar"
          aria-label="体检进度"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.checked}
        >
          <div
            className="health-progress-bar"
            style={{ width: progress.total > 0 ? `${Math.round(progress.checked / progress.total * 100)}%` : '0%' }}
          />
        </div>

        {/* 重测后相对上一轮的"结论变化"提示：用户要的是重测能看出哪些源和上次不一样。
            边测边报 —— 全库五千多个源要跑一小时，不能等跑完才说。 */}
        {run.baselineChanged > 0 && (
          <div className="health-baseline-note" role="status">
            <Icon name="activity" />
            <span>
              对比上一轮体检，<strong>{run.baselineChanged}</strong> 个源的结论变了
              {run.baselineWorse > 0 ? `（其中 ${run.baselineWorse} 个变差）` : ''}
              {run.running ? '，还在继续测…' : ''}
            </span>
          </div>
        )}

        {/* Stats and Filter Tabs */}
        <div className="health-stats-tabs">
          <div className="health-tabs">
            <button
              type="button"
              data-tier="all"
              className={`health-tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => setActiveTab('all')}
            >
              全部 ({stats.total})
            </button>
            <button
              type="button"
              data-tier="valid"
              className={`health-tab-btn ${activeTab === 'valid' ? 'active' : ''}`}
              onClick={() => setActiveTab('valid')}
            >
              正常 ({stats.valid})
            </button>
            <button
              type="button"
              data-tier="slow"
              className={`health-tab-btn ${activeTab === 'slow' ? 'active' : ''}`}
              onClick={() => setActiveTab('slow')}
            >
              迟缓 ({stats.slow})
            </button>
            <button
              type="button"
              data-tier="pending"
              className={`health-tab-btn ${activeTab === 'pending' ? 'active' : ''}`}
              onClick={() => setActiveTab('pending')}
            >
              待确认 ({stats.pending})
            </button>
            {/* 这一档单独列出来：它们一个请求都没发过，混进「连不上」就是体检最大的假数（652 / 5,574） */}
            <button
              type="button"
              data-tier="unconfigured"
              className={`health-tab-btn ${activeTab === 'unconfigured' ? 'active' : ''}`}
              onClick={() => setActiveTab('unconfigured')}
            >
              未配搜索 ({stats.unconfigured})
            </button>
            <button
              type="button"
              data-tier="dead"
              className={`health-tab-btn ${activeTab === 'dead' ? 'active' : ''}`}
              onClick={() => setActiveTab('dead')}
            >
              连不上 ({stats.dead})
            </button>
          </div>
          <div className="health-search-input">
            <Icon name="search" />
            <input
              type="text"
              placeholder="搜索检测结果…"
              value={filterQuery}
              onChange={e => setFilterQuery(e.target.value)}
            />
          </div>
        </div>

        {/*
          用户 2026-09-30：「不能根据获得信息正确规划分组」。
          体检跑完以前只给四个 tab 和两个批量停用按钮就结束了 —— 结论落在屏幕上，
          但没有一条能变成"分组"，要按体检结果整理还得一个源一个源手动挪。
          这一段把三档结论直接做成可执行的打标签/撤销，且只追加、不覆盖原分组。
        */}
        {!running && groupingPlans.length > 0 && (
          <section className="health-grouping" aria-label="按体检结果整理分组">
            <header>
              <strong>按体检结果整理分组</strong>
              <small>只追加标签，不动书源自带的分类；「待确认」不等于坏 —— 多半是差登录或要渲染 JS，先别停用。</small>
            </header>
            {groupingPlans.map(plan => (
              <div className="health-grouping-row" key={plan.tier}>
                <span className={`health-grouping-tag tier-${plan.tier}`}>{plan.tag}</span>
                <span className="health-grouping-count">
                  {plan.ids.length} 个{plan.alreadyApplied > 0 ? ` · ${plan.alreadyApplied} 个已打过` : ''}
                </span>
                <span className="health-grouping-examples" title={plan.examples.join('、')}>{plan.examples.join('、')}</span>
                {/*
                  体检过程中就自动打过标签了（sourceHealthRun 的那一半），所以跑完之后这一行常常是
                  "全部已打过"。以前那情况下仍然摆一颗**点不动的「打标签」**，用户读到的就是"按钮坏了"
                  （source-health-check 第 27 条一直红在这上面）。既然没有可打的，就不摆按钮，
                  改说一句状态；能撤销这件事仍然给得出来。
                */}
                {plan.alreadyApplied === plan.ids.length ? (
                  <span className="health-grouping-applied">已打好</span>
                ) : (
                  <button
                    type="button"
                    className="subtle-button health-grouping-apply"
                    disabled={busyAction !== null}
                    onClick={() => void applyTier(plan.tier, plan.ids)}
                  >
                    {plan.alreadyApplied > 0 ? `补打剩下 ${plan.ids.length - plan.alreadyApplied} 个` : '打标签'}
                  </button>
                )}
                <button
                  type="button"
                  className="ghost-button health-grouping-undo"
                  disabled={busyAction !== null || plan.alreadyApplied === 0}
                  onClick={() => void removeTier(plan.tier, plan.ids)}
                >
                  撤销
                </button>
              </div>
            ))}
          </section>
        )}

        {/* Action Quick Bar */}
        <div className="health-actions-bar">
          <div className="health-actions-left">
            <button
              type="button"
              className="subtle-button"
              onClick={() => void startCheck()}
              disabled={running || busyAction !== null || sourcesState !== 'ready' || scoped.length === 0}
            >
              <Icon name="refresh" className={running ? 'spin' : ''} />
              <span>
                {running
                  ? '体检中…'
                  : sourcesState !== 'ready'
                    ? sourcesState === 'loading' ? '正在读书源清单…' : '书源清单没取到'
                    : `${results.length > 0 ? '重新体检' : '开始体检'}（${scoped.length} 个${includeDisabled ? '' : '启用中的'}）`}
              </span>
            </button>
            {stats.dead > 0 && !running && (
              <button
                type="button"
                className="subtle-button"
                onClick={handleRetryFailed}
                disabled={busyAction !== null}
              >
                <span>重试连不上的 ({stats.dead})</span>
              </button>
            )}
          </div>
          {stats.dead > 0 && (
            <div className="health-actions-right">
              <button
                type="button"
                className="secondary-button"
                onClick={() => void handleBatchDisableFailed()}
                disabled={running || busyAction !== null}
              >
                <span>一键停用连不上的源 ({stats.dead})</span>
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => void handleBatchDeleteFailed()}
                disabled={running || busyAction !== null}
              >
                <span>一键删除连不上的源 ({stats.dead})</span>
              </button>
            </div>
          )}
        </div>

        {/* Results List */}
        <div className="health-results-list">
          {filteredResults.length === 0 ? (
            <div className="health-empty-state">
              <p>{running ? '体检进行中…'
                : sourcesState !== 'ready' ? '书源清单还没取到，这里暂时是空的'
                  : '无符合筛选条件的结果'}</p>
            </div>
          ) : (
            filteredResults.map(item => {
              // 结论标签取自服务端定的类；「待确认」不再被并进「失效」一起停用/删除
              const badgeClass = item.ok
                ? (item.statusCategory === 'slow' ? 'badge-slow' : 'badge-valid')
                : isDead(item.statusCategory) ? 'badge-failed'
                  : item.statusCategory === 'blocked' ? 'badge-blocked' : 'badge-pending'
              const badgeText = HEALTH_LABELS[item.statusCategory] ?? item.statusCategory

              return (
                <article key={item.id} className={`health-item-card ${item.statusCategory}`}>
                  <div className="health-item-main">
                    <div className="health-item-top">
                      <strong className="health-item-name">{item.name}</strong>
                      <span className={`health-badge ${badgeClass}`}>{badgeText}</span>
                      {item.latencyMs > 0 && (
                        <span className="health-latency">{item.latencyMs}ms</span>
                      )}
                      {item.statusCode > 0 && (
                        <span className="health-code">HTTP {item.statusCode}</span>
                      )}
                    </div>
                    <div className="health-item-url" title={item.id}>
                      {item.id}
                    </div>
                    {item.error && <p className="health-item-error">{item.error}</p>}
                  </div>
                  <div>
                    <button
                      type="button"
                      className="subtle-button"
                      title="单独重测"
                      onClick={() => handleRetrySingle(item.id)}
                      disabled={running}
                    >
                      <Icon name="refresh" />
                    </button>
                  </div>
                </article>
              )
            })
          )}
        </div>
      </div>
    </div>
  )
}
