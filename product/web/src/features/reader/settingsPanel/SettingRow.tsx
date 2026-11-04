import type { ReactNode } from 'react'

/**
 * 设置面板的共用行控件（P1 三标签页拆分时从 ReaderSettingsControls 抽出）。
 * 只管"一行长什么样"，不管值 —— 值的口径都在各 Tab 与 readerSettings.ts 里。
 */

/**
 * 设置项的解释。
 *
 * 说明文字不再占一整行（用户 2026-10-27：「设置里面的信息解释鼠标靠近悬浮显示」）：
 * 平时只留一个问号，鼠标靠近或键盘聚焦时浮出完整说明。文案仍写在各 Tab 里，与设置项同处。
 */
export function SettingHint({ text }: { text: string }) {
  return <span className="setting-hint-icon" role="note" tabIndex={0} aria-label={text} data-hint={text}>?</span>
}

/** 滑杆行：label + 当前值 + range。display 由调用方格式化（px / % / 倍…）。 */
export function SettingRange({ label, value, min, max, step, onChange, display, hint }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; display: string; hint?: string }) {
  return <label className="setting-range"><span>{label}{hint && <SettingHint text={hint} />}</span><output>{display}</output><input type="range" min={min} max={max} step={step} value={value} onChange={event => onChange(Number(event.target.value))} /></label>
}

/** 分段选择行：一组互斥按钮（.page-modes 那套观感）。选项值类型跟着泛型走，数字档（缩进）与字符串档（对齐）共用。 */
export function SettingChoices<T extends string | number>({ label, value, options, onChange, hint }: { label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange: (value: T) => void; hint?: string }) {
  return (
    <div className="setting-choice" role="group" aria-label={label}>
      <span>{label}{hint && <SettingHint text={hint} />}</span>
      <div className="page-modes">
        {options.map(option => (
          <button key={String(option.value)} type="button" className={value === option.value ? 'selected' : ''} onClick={() => onChange(option.value)}>{option.label}</button>
        ))}
      </div>
    </div>
  )
}

/** 小节标题。三标签页里的每一组都用它，保持同一节奏；解释走悬浮问号，不占正文。 */
export function SettingGroup({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="setting-section">
      <span className="setting-label">{title}{hint && <SettingHint text={hint} />}</span>
      {children}
    </section>
  )
}
