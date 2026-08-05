/* 同步早埋点：在 type=module 主包之前执行（CSP script-src 'self' 允许外链）。
   记录 HTML 阶段时间原点，供后续 React/i18n mark 对齐。 */
;(function () {
  var origin = performance.now()
  var wallOrigin = Date.now()
  var marks = [{ phase: 'html-boot-script', t: 0, wall: wallOrigin }]
  window.__ONE_STARTUP__ = {
    origin: origin,
    wallOrigin: wallOrigin,
    marks: marks,
    mark: function (phase, detail) {
      var t = performance.now() - origin
      marks.push({
        phase: phase,
        t: t,
        wall: Date.now(),
        detail: detail || undefined,
      })
      return t
    },
  }
})()
