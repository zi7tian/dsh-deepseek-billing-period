/**
 * DeepSeek API billing-period indicator — client half.
 *
 * Official billing rule (Beijing time, i.e. Asia/Shanghai / UTC+8):
 *   peak     Mon-Fri 09:00-12:00 and 14:00-18:00, excluding Chinese public holidays
 *   off-peak every other moment, including weekends and public holidays all day
 *   off-peak is billed at half the peak price
 *
 * Beijing wall-clock fields are derived arithmetically from UTC+8 (Asia/Shanghai
 * has observed no DST since 1991), so the answer never depends on the browser's
 * own time zone.
 *
 * Every module initialisation lives inside the factory closure; `apply` only
 * registers a locale dictionary and one `conversation.composer.dock` entry.
 */

window.__ModuleLoader__.load({
  id: 'dsh-deepseek-billing-period',
  factory(require) {
    const React = require('react');

    const NS = 'dsh-deepseek-billing-period';
    const SLOT = 'conversation.composer.dock';
    const ORDER = 10;
    const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
    const DAY_MS = 24 * 60 * 60 * 1000;
    const MINUTE_MS = 60 * 1000;
    /** Peak windows as Beijing minute-of-day `[start, end)` pairs. */
    const PEAK_WINDOWS = [
      [9 * 60, 12 * 60],
      [14 * 60, 18 * 60],
    ];
    /** Safety bound for the transition scan; a workday always occurs well inside it. */
    const MAX_SCAN_DAYS = 400;

    /*
     * Chinese public holidays, from the State Council's annual notices:
     *   2025 — 国办发明电〔2024〕12号
     *   2026 — 国办发明电〔2025〕7号
     * Only Mon-Fri dates can change the answer here, because a weekend is
     * off-peak anyway; 调休 make-up workdays that fall on a weekend are
     * irrelevant for the same reason.
     */
    const HOLIDAYS = [
      { name: 'holiday.newYear', from: '2025-01-01', to: '2025-01-01' },
      { name: 'holiday.springFestival', from: '2025-01-28', to: '2025-02-04' },
      { name: 'holiday.qingming', from: '2025-04-04', to: '2025-04-06' },
      { name: 'holiday.labourDay', from: '2025-05-01', to: '2025-05-05' },
      { name: 'holiday.dragonBoat', from: '2025-05-31', to: '2025-06-02' },
      { name: 'holiday.nationalDayMidAutumn', from: '2025-10-01', to: '2025-10-08' },
      { name: 'holiday.newYear', from: '2026-01-01', to: '2026-01-03' },
      { name: 'holiday.springFestival', from: '2026-02-15', to: '2026-02-23' },
      { name: 'holiday.qingming', from: '2026-04-04', to: '2026-04-06' },
      { name: 'holiday.labourDay', from: '2026-05-01', to: '2026-05-05' },
      { name: 'holiday.dragonBoat', from: '2026-06-19', to: '2026-06-21' },
      { name: 'holiday.midAutumn', from: '2026-09-25', to: '2026-09-27' },
      { name: 'holiday.nationalDay', from: '2026-10-01', to: '2026-10-07' },
    ];

    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /** Beijing wall-clock fields of an epoch instant. */
    function fieldsAt(ms) {
      const date = new Date(ms + BJ_OFFSET_MS);
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        weekday: date.getUTCDay(),
        hour: date.getUTCHours(),
        minute: date.getUTCMinutes(),
        second: date.getUTCSeconds(),
      };
    }

    function dateKeyOf(fields) {
      return fields.year + '-' + pad2(fields.month) + '-' + pad2(fields.day);
    }

    /** Epoch instant of 00:00 Beijing time for the day containing `ms`. */
    function dayStartOf(ms) {
      const fields = fieldsAt(ms);
      return Date.UTC(fields.year, fields.month - 1, fields.day) - BJ_OFFSET_MS;
    }

    /** Epoch instant of 00:00 Beijing time on a `YYYY-MM-DD` date. */
    function parseDateKey(text) {
      const parts = text.split('-');
      return Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) - BJ_OFFSET_MS;
    }

    const HOLIDAY_INDEX = new Map();
    const HOLIDAY_YEARS = new Set();
    for (const entry of HOLIDAYS) {
      const end = parseDateKey(entry.to);
      for (let day = parseDateKey(entry.from); day <= end; day += DAY_MS) {
        HOLIDAY_INDEX.set(dateKeyOf(fieldsAt(day)), entry.name);
      }
      HOLIDAY_YEARS.add(Number(entry.from.slice(0, 4)));
      HOLIDAY_YEARS.add(Number(entry.to.slice(0, 4)));
    }

    function holidayNameAt(ms) {
      const name = HOLIDAY_INDEX.get(dateKeyOf(fieldsAt(ms)));
      return name === undefined ? null : name;
    }

    function holidayYears() {
      return Array.from(HOLIDAY_YEARS).sort(function (a, b) {
        return a - b;
      });
    }

    function coversYear(year) {
      return HOLIDAY_YEARS.has(year);
    }

    /** Billing state at one instant: `peak` plus the calendar facts behind it. */
    function evaluate(ms) {
      const fields = fieldsAt(ms);
      const holiday = holidayNameAt(ms);
      const weekend = fields.weekday === 0 || fields.weekday === 6;
      const minutes = fields.hour * 60 + fields.minute;
      const insideWindow = PEAK_WINDOWS.some(function (window) {
        return minutes >= window[0] && minutes < window[1];
      });
      return {
        fields: fields,
        holiday: holiday,
        weekend: weekend,
        peak: !weekend && holiday === null && insideWindow,
      };
    }

    /** Whether the Beijing day starting at `dayStartMs` follows the Mon-Fri rule. */
    function isWorkday(dayStartMs) {
      const fields = fieldsAt(dayStartMs + 12 * 60 * MINUTE_MS);
      if (fields.weekday === 0 || fields.weekday === 6) return false;
      return !HOLIDAY_INDEX.has(dateKeyOf(fields));
    }

    /**
     * Next instant strictly after `ms` at which the billing state flips.
     * Transitions can only happen at 09:00/12:00/14:00/18:00 on a workday, so
     * the scan only visits those four candidates per day.
     */
    function nextChange(ms) {
      const current = evaluate(ms).peak;
      let dayStart = dayStartOf(ms);
      for (let index = 0; index < MAX_SCAN_DAYS; index += 1) {
        if (isWorkday(dayStart)) {
          for (let w = 0; w < PEAK_WINDOWS.length; w += 1) {
            for (let edge = 0; edge < PEAK_WINDOWS[w].length; edge += 1) {
              const at = dayStart + PEAK_WINDOWS[w][edge] * MINUTE_MS;
              if (at <= ms) continue;
              if (evaluate(at).peak !== current) return { at: at, peak: !current };
            }
          }
        }
        dayStart += DAY_MS;
      }
      return null;
    }

    function hhmm(ms) {
      const fields = fieldsAt(ms);
      return pad2(fields.hour) + ':' + pad2(fields.minute);
    }

    function interpolate(template, params) {
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
      });
    }

    const DICTS = {
      zh: {
        'label.peak': '高峰时段 · 全价',
        'label.offpeak': '空闲时段 · 半价',
        'phase.peak': '高峰时段',
        'phase.offpeak': '空闲时段',
        'next.toPeak': '距高峰 {remaining}',
        'next.toOffpeak': '距空闲 {remaining}',
        'remaining.hours': '{hours} 小时 {minutes} 分',
        'remaining.minutes': '{minutes} 分 {seconds} 秒',
        'remaining.seconds': '{seconds} 秒',
        'weekday.0': '周日',
        'weekday.1': '周一',
        'weekday.2': '周二',
        'weekday.3': '周三',
        'weekday.4': '周四',
        'weekday.5': '周五',
        'weekday.6': '周六',
        'holiday.newYear': '元旦',
        'holiday.springFestival': '春节',
        'holiday.qingming': '清明节',
        'holiday.labourDay': '劳动节',
        'holiday.dragonBoat': '端午节',
        'holiday.midAutumn': '中秋节',
        'holiday.nationalDay': '国庆节',
        'holiday.nationalDayMidAutumn': '国庆节·中秋节',
        'detail.heading': 'DeepSeek API 计费时段（北京时间）',
        'detail.peak': '高峰：周一至周五 09:00–12:00、14:00–18:00（不含中国法定节假日）',
        'detail.offpeak': '空闲：其余全部时段（含周末及法定节假日全天），价格为高峰时段的一半',
        'detail.clock': '当前北京时间：{clock}',
        'detail.next': '下一时段：{phase}，北京时间 {time} 起',
        'detail.holidayToday': '今日为法定节假日（{name}），全天空闲',
        'detail.weekendToday': '今日为周末，全天空闲',
        'detail.workdayToday': '今日为工作日，按上述时段切换',
        'detail.coverage': '节假日数据覆盖 {years} 年；其他年份仅按周一至周五判断',
        'detail.uncovered': '尚未收录 {year} 年的法定节假日安排，该年仅按周一至周五判断',
        'aria.toggle': '展开或收起 DeepSeek 计费时段说明',
        'dialog.title': '高峰时段发送确认',
        'dialog.description': '当前处于高峰时段（全价）。这条消息将按高峰价格计费，仍要发送吗？',
        'dialog.confirm': '确认发送',
        'dialog.cancel': '取消',
        'dialog.close': '关闭',
        'dialog.askEvery': '高峰时段发送消息时，是否需要每次确认',
        'dialog.skipHint': '已勾选：下次不再询问',
        'setting.confirm': '高峰时段发送前确认',
        'setting.confirmTitle': '关闭后高峰时段直接发送，不再弹窗确认',
      },
      en: {
        'label.peak': 'Peak · full price',
        'label.offpeak': 'Off-peak · half price',
        'phase.peak': 'peak',
        'phase.offpeak': 'off-peak',
        'next.toPeak': 'peak in {remaining}',
        'next.toOffpeak': 'off-peak in {remaining}',
        'remaining.hours': '{hours}h {minutes}m',
        'remaining.minutes': '{minutes}m {seconds}s',
        'remaining.seconds': '{seconds}s',
        'weekday.0': 'Sun',
        'weekday.1': 'Mon',
        'weekday.2': 'Tue',
        'weekday.3': 'Wed',
        'weekday.4': 'Thu',
        'weekday.5': 'Fri',
        'weekday.6': 'Sat',
        'holiday.newYear': "New Year's Day",
        'holiday.springFestival': 'Spring Festival',
        'holiday.qingming': 'Qingming Festival',
        'holiday.labourDay': 'Labour Day',
        'holiday.dragonBoat': 'Dragon Boat Festival',
        'holiday.midAutumn': 'Mid-Autumn Festival',
        'holiday.nationalDay': 'National Day',
        'holiday.nationalDayMidAutumn': 'National Day & Mid-Autumn Festival',
        'detail.heading': 'DeepSeek API billing periods (Beijing time)',
        'detail.peak': 'Peak: Mon–Fri 09:00–12:00 and 14:00–18:00 (Chinese public holidays excluded)',
        'detail.offpeak': 'Off-peak: every other moment, weekends and public holidays all day; half the peak price',
        'detail.clock': 'Beijing time now: {clock}',
        'detail.next': 'Next period: {phase} from {time} Beijing time',
        'detail.holidayToday': 'Public holiday today ({name}) — off-peak all day',
        'detail.weekendToday': 'Weekend today — off-peak all day',
        'detail.workdayToday': 'Workday today — periods switch as listed above',
        'detail.coverage': 'Holiday data covers {years}; other years follow the weekday rule only',
        'detail.uncovered': 'The {year} public-holiday schedule is not bundled yet — that year follows the weekday rule only',
        'aria.toggle': 'Toggle the DeepSeek billing-period details',
        'dialog.title': 'Send during peak hours?',
        'dialog.description':
          'DeepSeek API pricing is at peak (full price) right now, so this message is billed at the peak rate. Send it anyway?',
        'dialog.confirm': 'Send anyway',
        'dialog.cancel': 'Cancel',
        'dialog.close': 'Close',
        'dialog.askEvery': 'Ask every time before sending during peak hours',
        'dialog.skipHint': 'Checked: will not ask again',
        'setting.confirm': 'Confirm before peak-hour sends',
        'setting.confirmTitle': 'Turn off to send straight away during peak hours, without the dialog',
      },
    };

    function fallbackTranslate(key, params) {
      const language =
        typeof navigator !== 'undefined' && typeof navigator.language === 'string'
          ? navigator.language.toLowerCase()
          : '';
      const dict = language.indexOf('zh') === 0 ? DICTS.zh : DICTS.en;
      const template =
        dict[key] !== undefined ? dict[key] : DICTS.en[key] !== undefined ? DICTS.en[key] : key;
      return interpolate(template, params);
    }

    /**
     * Resolve `t` from the installed locale face, but fall back to the bundled
     * dictionary whenever that face cannot resolve a key (unknown namespace),
     * so a missing locale registration can never leak raw keys into the UI.
     */
    function makeTranslate(t) {
      if (typeof t !== 'function') return fallbackTranslate;
      return function (key, params) {
        const value = t(key, params);
        if (typeof value === 'string' && value !== key) return value;
        return fallbackTranslate(key, params);
      };
    }

    function formatRemaining(ms, t) {
      const total = Math.max(0, Math.floor(ms / 1000));
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      if (hours > 0) return t('remaining.hours', { hours: hours, minutes: minutes });
      if (minutes > 0) return t('remaining.minutes', { minutes: minutes, seconds: seconds });
      return t('remaining.seconds', { seconds: seconds });
    }

    /** Everything the pill renders, derived from one instant. */
    function describe(ms, t) {
      const state = evaluate(ms);
      const change = nextChange(ms);
      const fields = state.fields;
      const label = t(state.peak ? 'label.peak' : 'label.offpeak');
      const countdown =
        change === null
          ? ''
          : t(change.peak ? 'next.toPeak' : 'next.toOffpeak', {
              remaining: formatRemaining(change.at - ms, t),
            });
      const coverage = t('detail.coverage', { years: holidayYears().join(' / ') });
      const lines = [
        t('detail.peak'),
        t('detail.offpeak'),
        t('detail.clock', {
          clock:
            dateKeyOf(fields) + ' ' + t('weekday.' + fields.weekday) + ' ' + hhmm(ms) + ':' + pad2(fields.second),
        }),
        change === null
          ? ''
          : t('detail.next', { phase: t(change.peak ? 'phase.peak' : 'phase.offpeak'), time: hhmm(change.at) }),
        state.holiday !== null
          ? t('detail.holidayToday', { name: t(state.holiday) })
          : state.weekend
            ? t('detail.weekendToday')
            : t('detail.workdayToday'),
        coverage,
      ];
      if (!coversYear(fields.year)) lines.push(t('detail.uncovered', { year: fields.year }));
      return {
        peak: state.peak,
        label: label,
        countdown: countdown,
        dot: state.peak
          ? 'var(--dsw-alias-state-warn-primary, #d97706)'
          : 'var(--dsw-alias-state-success-primary, #16a34a)',
        heading: t('detail.heading'),
        lines: lines.filter(function (line) {
          return typeof line === 'string' && line !== '';
        }),
        title: label + (countdown === '' ? '' : ' · ' + countdown) + '\n' + t('detail.peak') + '\n' + t('detail.offpeak'),
      };
    }

    /* Host primitives (dialog chrome) are optional: requiring them must never take
       the whole plugin down, and the panel/dock markup above stays React-only. */
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch (error) {
      primitives = null;
    }

    /** localStorage key holding this plugin's user preferences. */
    const PREFS_KEY = 'dsh-deepseek-billing-period.prefs';
    /** Defaults: every peak-hour send is confirmed unless the user opts out. */
    const DEFAULT_PREFS = { confirmOnPeakSend: true };

    /**
     * Read the durable preferences, tolerating an absent/corrupt store.
     * @param storage - a `Storage`-like object (undefined outside the browser).
     * @returns the resolved preferences (defaults when nothing is stored).
     */
    function readPrefs(storage) {
      if (!storage || typeof storage.getItem !== 'function') return { confirmOnPeakSend: true };
      try {
        const raw = storage.getItem(PREFS_KEY);
        if (typeof raw !== 'string' || raw === '') return { confirmOnPeakSend: true };
        const parsed = JSON.parse(raw);
        return { confirmOnPeakSend: !(parsed && parsed.confirmOnPeakSend === false) };
      } catch (error) {
        return { confirmOnPeakSend: true };
      }
    }

    /**
     * Persist the preferences, ignoring a store that refuses writes.
     * @param storage - a `Storage`-like object.
     * @param prefs - the preferences to store.
     */
    function writePrefs(storage, prefs) {
      if (!storage || typeof storage.setItem !== 'function') return;
      try {
        storage.setItem(
          PREFS_KEY,
          JSON.stringify({ confirmOnPeakSend: !(prefs && prefs.confirmOnPeakSend === false) }),
        );
      } catch (error) {
        /* private mode / quota: the in-memory preference still applies this session. */
      }
    }

    /** The browser's durable store, or `null` when it is unavailable/blocked. */
    function storageOf() {
      try {
        return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null;
      } catch (error) {
        return null;
      }
    }

    /** Localized accessible names the host gives its primary composer button. */
    const SEND_LABEL_RE = /^(发送消息|排队发送|插话发送|Send message|Queue message|Steer message)$/;
    /** Locale-independent fallback: the arrow glyph the send state renders. */
    const SEND_ICON_SELECTOR = 'path[d^="M8.3125 0.980183"]';

    /** The composer's editable element (`null` outside a composer). */
    function editorOf(card) {
      if (!card || typeof card.querySelector !== 'function') return null;
      return card.querySelector('[contenteditable="true"], textarea, [role="textbox"]');
    }

    /**
     * Walk up from our own dock node to the composer card that owns the editor.
     * @param node - the plugin's root element.
     * @returns the composer card element, or `null`.
     */
    function composerCardOf(node) {
      if (typeof document === 'undefined' || !node) return null;
      let current = node;
      while (current && current.nodeType === 1 && current !== document.documentElement) {
        if (editorOf(current)) return current;
        current = current.parentElement;
      }
      return null;
    }

    /**
     * The composer's primary button in its *send* state. While a turn runs the
     * same button becomes Stop, which this deliberately does not match.
     * @param card - the composer card element.
     * @returns the send button, or `null`.
     */
    function sendButtonOf(card) {
      if (!card || typeof card.querySelectorAll !== 'function') return null;
      const buttons = card.querySelectorAll('button');
      let iconMatch = null;
      for (let index = 0; index < buttons.length; index += 1) {
        const button = buttons[index];
        const label = typeof button.getAttribute === 'function' ? button.getAttribute('aria-label') : null;
        if (typeof label === 'string' && SEND_LABEL_RE.test(label)) return button;
        if (iconMatch === null && button.querySelector(SEND_ICON_SELECTOR)) iconMatch = button;
      }
      return iconMatch;
    }

    /** The draft text, used to leave `/` commands to the command plane. */
    function draftTextOf(card) {
      const editor = editorOf(card);
      if (!editor) return '';
      if (typeof editor.value === 'string') return editor.value;
      return typeof editor.textContent === 'string' ? editor.textContent : '';
    }

    const ROOT_STYLE = {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '2px',
      fontSize: 'calc(var(--dsh-content-font-size-secondary, 13px) - 1px)',
      lineHeight: 'calc(20px + var(--dsh-content-font-delta-secondary, 0px))',
    };
    const PILL_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      padding: '1px 8px',
      borderRadius: '999px',
      border: 'none',
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      font: 'inherit',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
      cursor: 'pointer',
    };
    const PILL_ACTIVE_STYLE = {
      background: 'var(--dsw-alias-interactive-bg-hover, transparent)',
      color: 'var(--dsw-alias-label-secondary)',
    };
    const DOT_STYLE = { width: '6px', height: '6px', borderRadius: '50%', flex: 'none' };
    const DOT_IDLE_STYLE = { opacity: 0.75 };
    /* Floating card: the panel is taken out of flow and anchored above the pill,
       so opening it never changes the composer dock's height. The surface copies
       the host's own composer popover recipe token for token (translucent layer +
       hairline ring + soft shadow) rather than hardcoding colours, so it follows
       the active palette in both light and dark mode. */
    const PANEL_ANCHOR_STYLE = {
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      left: '50%',
      transform: 'translateX(-50%)',
      zIndex: 40,
      display: 'flex',
      justifyContent: 'center',
      pointerEvents: 'auto',
    };
    const PANEL_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      width: 'max-content',
      maxWidth: 'min(560px, calc(100vw - 24px))',
      boxSizing: 'border-box',
      padding: '12px',
      border: 0,
      borderRadius: 'var(--dsw-radius-lg, 16px)',
      background: 'var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2, #fff))',
      backdropFilter: 'var(--dsw-menu-backdrop-filter)',
      WebkitBackdropFilter: 'var(--dsw-menu-backdrop-filter)',
      '--dsw-elevation-stroke-color': 'var(--dsw-alias-border-l1)',
      boxShadow:
        'var(--dsw-elevation-prominent, 0 0 0 0.5px rgba(0, 0, 0, 0.04), 0 3px 8px 0 rgba(0, 0, 0, 0.04), 0 0 20px 0 rgba(0, 0, 0, 0.05))',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '12px',
      textAlign: 'center',
      whiteSpace: 'normal',
      lineHeight: '20px',
      fontVariantNumeric: 'tabular-nums',
    };
    const HEADING_STYLE = { color: 'var(--dsw-alias-label-primary)', marginBottom: '2px' };
    const LINE_STYLE = {};
    /* Footer row of the rule card: the entry point that turns peak-hour send
       confirmation back on after it was dismissed with "do not ask again". */
    const PANEL_FOOTER_STYLE = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '6px',
      marginTop: '4px',
      paddingTop: '6px',
      borderTop: '1px solid var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06))',
      color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      cursor: 'pointer',
    };
    const FALLBACK_CHECKBOX_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '6px',
      cursor: 'pointer',
      color: 'inherit',
    };
    /* Self-contained dialog surface, used only when host primitives are absent. */
    const DIALOG_MASK_STYLE = {
      position: 'fixed',
      inset: 0,
      zIndex: 1200,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--dsw-alias-bg-overlay, rgba(0, 0, 0, 0.35))',
    };
    const DIALOG_CARD_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      width: 'min(420px, calc(100vw - 48px))',
      boxSizing: 'border-box',
      padding: '16px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
      borderRadius: 'var(--dsw-radius-lg, 16px)',
      background: 'var(--dsw-alias-bg-layer-2, #fff)',
      boxShadow: 'var(--dsw-elevation-prominent, 0 8px 24px rgba(0, 0, 0, 0.12))',
      color: 'var(--dsw-alias-label-secondary)',
      fontSize: '13px',
      lineHeight: '20px',
      textAlign: 'left',
    };
    const DIALOG_TITLE_STYLE = { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600 };
    const DIALOG_OPTION_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '2px',
      color: 'var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary))',
      fontSize: '12px',
    };
    const DIALOG_FOOTER_STYLE = { display: 'flex', justifyContent: 'flex-end', gap: '8px' };
    const DIALOG_BUTTON_STYLE = {
      padding: '6px 14px',
      borderRadius: 'var(--dsw-radius-md, 8px)',
      border: '1px solid var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.1))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      cursor: 'pointer',
    };
    const DIALOG_CONFIRM_STYLE = Object.assign({}, DIALOG_BUTTON_STYLE, {
      border: '1px solid transparent',
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(38, 49, 72, 0.06))',
      fontWeight: 600,
    });

    /**
     * A host switch/checkbox when the primitives package is loaded, and a plain
     * native input otherwise — either way the caller owns any visible text.
     */
    function ToggleControl(props) {
      const kind =
        props.kind === 'switch'
          ? primitives && typeof primitives.Switch === 'function'
            ? primitives.Switch
            : null
          : primitives && typeof primitives.Checkbox === 'function'
            ? primitives.Checkbox
            : null;
      if (kind) {
        return React.createElement(kind, {
          checked: props.checked === true,
          onChange: props.onChange,
          label: props.label,
          title: props.title,
        });
      }
      return React.createElement(
        'label',
        { style: FALLBACK_CHECKBOX_STYLE, title: props.title },
        React.createElement('input', {
          type: 'checkbox',
          checked: props.checked === true,
          onChange: function (event) {
            props.onChange(event.target.checked);
          },
        }),
        props.kind === 'switch' ? null : React.createElement('span', null, props.label),
      );
    }

    /**
     * The peak-hour send confirmation. Presentational only: the caller owns the
     * pending gesture, the preference write and the replay.
     * @param props.open - whether a send is waiting for an answer.
     * @param props.t - translator for the plugin namespace.
     * @param props.skipNext - the "do not ask again" checkbox state.
     */
    function PeakSendDialog(props) {
      const t = props.t;
      React.useEffect(
        function () {
          if (!props.open) {
            return undefined;
          }
          function onKeyDown(event) {
            if (event.key === 'Escape') {
              props.onCancel();
            }
          }
          window.addEventListener('keydown', onKeyDown, true);
          return function () {
            window.removeEventListener('keydown', onKeyDown, true);
          };
        },
        [props.open, props.onCancel],
      );
      if (!props.open) {
        return null;
      }
      const body = React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        React.createElement('div', null, t('dialog.description')),
        React.createElement(
          'div',
          { style: DIALOG_OPTION_STYLE },
          React.createElement(ToggleControl, {
            kind: 'checkbox',
            checked: props.skipNext,
            onChange: props.onToggleSkip,
            label: t('dialog.askEvery'),
          }),
          props.skipNext ? React.createElement('div', null, t('dialog.skipHint')) : null,
        ),
      );
      if (primitives && typeof primitives.Modal === 'function' && typeof primitives.Button === 'function') {
        return React.createElement(
          primitives.Modal,
          {
            open: true,
            onClose: props.onCancel,
            title: t('dialog.title'),
            closeLabel: t('dialog.close'),
            footer: [
              React.createElement(
                primitives.Button,
                { key: 'cancel', variant: 'ghost', onClick: props.onCancel },
                t('dialog.cancel'),
              ),
              React.createElement(
                primitives.Button,
                { key: 'confirm', variant: 'primary', onClick: props.onConfirm },
                t('dialog.confirm'),
              ),
            ],
          },
          body,
        );
      }
      return React.createElement(
        'div',
        { style: DIALOG_MASK_STYLE },
        React.createElement(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('dialog.title'),
            style: DIALOG_CARD_STYLE,
          },
          React.createElement('div', { style: DIALOG_TITLE_STYLE }, t('dialog.title')),
          body,
          React.createElement(
            'div',
            { style: DIALOG_FOOTER_STYLE },
            React.createElement(
              'button',
              { type: 'button', style: DIALOG_BUTTON_STYLE, onClick: props.onCancel },
              t('dialog.cancel'),
            ),
            React.createElement(
              'button',
              { type: 'button', style: DIALOG_CONFIRM_STYLE, onClick: props.onConfirm },
              t('dialog.confirm'),
            ),
          ),
        ),
      );
    }

    function BillingPeriod(props) {
      const t = makeTranslate(props.t);
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [now, setNow] = React.useState(function () {
        return Date.now();
      });
      const rootRef = React.useRef(null);
      /* Peak-hour send confirmation: the durable preference, the send gesture that
         is waiting for an answer, the "do not ask again" checkbox, and the bypass
         flag that lets the confirmed gesture through untouched. */
      const [prefs, setPrefs] = React.useState(function () {
        return readPrefs(storageOf());
      });
      const [pending, setPending] = React.useState(null);
      const [skipNext, setSkipNext] = React.useState(false);
      const pendingRef = React.useRef(null);
      const bypassRef = React.useRef(false);
      pendingRef.current = pending;

      function setConfirm(next) {
        const value = next === true;
        setPrefs({ confirmOnPeakSend: value });
        writePrefs(storageOf(), { confirmOnPeakSend: value });
      }

      /* Returning the caret to the composer keeps the next Enter a real composer
         gesture instead of a dead key press on a detached dialog button. */
      function focusComposer() {
        const card = composerCardOf(rootRef.current);
        const editor = card ? editorOf(card) : null;
        if (editor && typeof editor.focus === 'function') {
          try {
            editor.focus();
          } catch (error) {
            /* the editor may already be gone */
          }
        }
      }

      function dismissPending() {
        pendingRef.current = null;
        setPending(null);
        setSkipNext(false);
        focusComposer();
      }

      /* Replay the intercepted gesture; the bypass flag keeps our own listeners
         from intercepting it a second time. */
      function confirmPending() {
        const request = pendingRef.current;
        pendingRef.current = null;
        setPending(null);
        setSkipNext(false);
        if (skipNext) {
          setConfirm(false);
        }
        bypassRef.current = true;
        try {
          if (request && request.kind === 'click' && request.button && typeof request.button.click === 'function') {
            request.button.click();
          } else if (
            request &&
            typeof KeyboardEvent === 'function' &&
            request.target &&
            typeof request.target.dispatchEvent === 'function'
          ) {
            request.target.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              }),
            );
          }
        } finally {
          bypassRef.current = false;
        }
      }

      React.useEffect(function () {
        const handle = setInterval(function () {
          setNow(Date.now());
        }, 1000);
        return function () {
          clearInterval(handle);
        };
      }, []);

      /* Dismiss the floating panel on any click outside it (and on Escape). */
      React.useEffect(function () {
        if (!open) {
          return undefined;
        }
        function onPointerDown(event) {
          const root = rootRef.current;
          if (root && event.target && root.contains(event.target)) {
            return;
          }
          setOpen(false);
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }
        document.addEventListener('mousedown', onPointerDown, true);
        document.addEventListener('touchstart', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return function () {
          document.removeEventListener('mousedown', onPointerDown, true);
          document.removeEventListener('touchstart', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open]);

      /* Peak-hour interception. Both listeners sit on `document` in the capture
         phase, ahead of the host's own window-bubble dispatch, so the gesture can
         be cancelled before it submits; the confirmed one is replayed by
         confirmPending() through the bypass flag. */
      React.useEffect(
        function () {
          if (!prefs.confirmOnPeakSend) {
            return undefined;
          }
          function intercept(card, gesture) {
            if (bypassRef.current || pendingRef.current) {
              return;
            }
            if (!evaluate(Date.now()).peak) {
              return;
            }
            gesture.preventDefault();
            gesture.stopImmediatePropagation();
            setSkipNext(false);
            pendingRef.current = card;
            setPending(card);
          }
          function onKeyDownCapture(event) {
            if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
              return;
            }
            if (event.isComposing === true || event.keyCode === 229) {
              return;
            }
            const card = composerCardOf(rootRef.current);
            if (!card) {
              return;
            }
            const editor = editorOf(card);
            const target = event.target;
            if (!editor || !target || (target !== editor && !(editor.contains && editor.contains(target)))) {
              return;
            }
            const draft = draftTextOf(card);
            if (draft.trim().charAt(0) === '/') {
              /* A slash command is not a billable message; let the command plane have it. */
              return;
            }
            intercept({ kind: 'key', button: sendButtonOf(card), target: target }, event);
          }
          function onClickCapture(event) {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') {
              return;
            }
            const button = target.closest('button');
            if (!button) {
              return;
            }
            const card = composerCardOf(rootRef.current);
            if (!card || !card.contains(button) || sendButtonOf(card) !== button) {
              return;
            }
            intercept({ kind: 'click', button: button, target: null }, event);
          }
          document.addEventListener('keydown', onKeyDownCapture, true);
          document.addEventListener('click', onClickCapture, true);
          return function () {
            document.removeEventListener('keydown', onKeyDownCapture, true);
            document.removeEventListener('click', onClickCapture, true);
          };
        },
        [prefs.confirmOnPeakSend],
      );

      const view = describe(now, t);
      const pillStyle = Object.assign({}, PILL_STYLE, open || hover ? PILL_ACTIVE_STYLE : null);

      return React.createElement(
        'div',
        { style: ROOT_STYLE, ref: rootRef },
        React.createElement(
          'button',
          {
            type: 'button',
            style: pillStyle,
            'aria-expanded': open,
            'aria-label': t('aria.toggle'),
            onClick: function () {
              setOpen(function (value) {
                return !value;
              });
            },
            onMouseEnter: function () {
              setHover(true);
            },
            onMouseLeave: function () {
              setHover(false);
            },
          },
          React.createElement('span', {
            'aria-hidden': 'true',
            style: Object.assign({}, DOT_STYLE, DOT_IDLE_STYLE, { background: view.dot }),
          }),
          React.createElement('span', null, view.label),
          view.countdown === ''
            ? null
            : React.createElement('span', { style: { opacity: 0.7 } }, '·'),
          view.countdown === '' ? null : React.createElement('span', null, view.countdown),
        ),
        open
          ? React.createElement(
              'div',
              { style: PANEL_ANCHOR_STYLE },
              React.createElement(
                'div',
                { style: PANEL_STYLE, role: 'dialog', 'aria-label': view.heading },
                React.createElement('div', { style: HEADING_STYLE }, view.heading),
                view.lines.map(function (line, index) {
                  return React.createElement('div', { key: index, style: LINE_STYLE }, line);
                }),
                /* Entry point back to the confirmation after "do not ask again". */
                React.createElement(
                  'div',
                  { style: PANEL_FOOTER_STYLE },
                  React.createElement(ToggleControl, {
                    kind: 'switch',
                    checked: prefs.confirmOnPeakSend,
                    onChange: setConfirm,
                    label: t('setting.confirm'),
                    title: t('setting.confirmTitle'),
                  }),
                  React.createElement('span', null, t('setting.confirm')),
                ),
              ),
            )
          : null,
        React.createElement(PeakSendDialog, {
          open: pending !== null,
          t: t,
          skipNext: skipNext,
          onToggleSkip: setSkipNext,
          onCancel: dismissPending,
          onConfirm: confirmPending,
        }),
      );
    }

    function apply(ctx) {
      ctx.inject(['locale'], function (localeCtx) {
        ctx.effect(function () {
          try {
            return localeCtx.locale.register(NS, DICTS);
          } catch (error) {
            /* A duplicate instance already owns this namespace; its dictionaries stand. */
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[deepseek-billing-period] locale registration skipped:', error);
            }
            return function () {};
          }
        }, 'deepseek-billing-period: locale');
      });

      ctx.inject(['slots'], function (slotsCtx) {
        slotsCtx.slots.inject(SLOT, function () {
          return slotsCtx.slots.register(
            { name: SLOT, id: 'deepseek-billing-period', order: ORDER, locale: NS },
            BillingPeriod,
          );
        });
      });
    }

    return {
      inject: ['slots'],
      apply: apply,
      /** Test seam: pure billing-period logic, also exercised by test/logic.test.mjs. */
      billingPeriod: {
        BJ_OFFSET_MS: BJ_OFFSET_MS,
        PEAK_WINDOWS: PEAK_WINDOWS,
        PREFS_KEY: PREFS_KEY,
        DEFAULT_PREFS: DEFAULT_PREFS,
        SEND_LABEL_RE: SEND_LABEL_RE,
        readPrefs: readPrefs,
        writePrefs: writePrefs,
        DICTS: DICTS,
        describe: describe,
        fallbackTranslate: fallbackTranslate,
        makeTranslate: makeTranslate,
        coversYear: coversYear,
        fieldsAt: fieldsAt,
        dayStartOf: dayStartOf,
        holidayNameAt: holidayNameAt,
        holidayYears: holidayYears,
        evaluate: evaluate,
        isWorkday: isWorkday,
        nextChange: nextChange,
        formatRemaining: formatRemaining,
      },
    };
  },
});
