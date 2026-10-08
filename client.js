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
       so opening it never changes the composer dock's height. Surface matches the
       host's own composer popover (translucent layer + hairline ring + soft
       shadow) so it does not stand out from the rest of the UI. */
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
      padding: '10px 12px',
      borderRadius: 'var(--dsw-radius-lg, 16px)',
      background: 'rgba(248, 249, 250, 0.92)',
      boxShadow:
        '0 0 0 0.5px rgba(0, 0, 0, 0.04), 0 3px 8px 0 rgba(0, 0, 0, 0.04), 0 0 20px 0 rgba(0, 0, 0, 0.05)',
      color: 'var(--dsw-alias-label-secondary)',
      textAlign: 'center',
      whiteSpace: 'normal',
      lineHeight: 1.5,
      fontVariantNumeric: 'tabular-nums',
    };
    const HEADING_STYLE = { color: 'var(--dsw-alias-label-primary)', marginBottom: '2px' };
    const LINE_STYLE = {};

    function BillingPeriod(props) {
      const t = makeTranslate(props.t);
      const [open, setOpen] = React.useState(false);
      const [hover, setHover] = React.useState(false);
      const [now, setNow] = React.useState(function () {
        return Date.now();
      });
      const rootRef = React.useRef(null);

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
                { style: PANEL_STYLE, role: 'tooltip' },
                React.createElement('div', { style: HEADING_STYLE }, view.heading),
                view.lines.map(function (line, index) {
                  return React.createElement('div', { key: index, style: LINE_STYLE }, line);
                }),
              ),
            )
          : null,
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
