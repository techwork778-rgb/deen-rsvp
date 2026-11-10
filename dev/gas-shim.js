// Local replacement for the google.script.* client API that Apps Script injects into web apps.
(function () {
  function runner(h) {
    return new Proxy({}, {
      get: function (_, name) {
        if (name === 'withSuccessHandler') return function (fn) { return runner(Object.assign({}, h, { ok: fn })); };
        if (name === 'withFailureHandler') return function (fn) { return runner(Object.assign({}, h, { fail: fn })); };
        if (name === 'withUserObject') return function (o) { return runner(Object.assign({}, h, { user: o })); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/__gas/' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args) })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if ('error' in res) { if (h.fail) h.fail(new Error(res.error), h.user); return; }
              if (h.ok) h.ok(res.value, h.user);
            })
            .catch(function (e) { if (h.fail) h.fail(e, h.user); });
        };
      }
    });
  }
  window.google = {
    script: {
      run: runner({}),
      url: {
        getLocation: function (cb) {
          var p = {};
          new URLSearchParams(location.search).forEach(function (v, k) { p[k] = v; });
          cb({ parameter: p, parameters: {}, hash: location.hash.replace(/^#/, '') });
        }
      },
      host: { close: function () {}, setHeight: function () {}, setWidth: function () {}, origin: location.origin },
      history: { push: function () {}, replace: function () {}, setChangeHandler: function () {} }
    }
  };
})();
