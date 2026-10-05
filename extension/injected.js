/**
 * Injected into the page's MAIN world on flow.google.com — has access to window.grecaptcha.
 *
 * Protects window.grecaptcha.enterprise.execute from Angular's x2a poison wrapper
 * which otherwise overrides every extension call with action: "extension_hijack_detected"
 * and triggers PUBLIC_ERROR_UNUSUAL_ACTIVITY.
 */
(function () {
  if (window.__FLOWKIT_INJECTED__) return;
  window.__FLOWKIT_INJECTED__ = true;

  var SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

  // ─── reCAPTCHA Anti-Hijack Protection ───────────────────────
  let _realExecute = null;

  function hookEnterprise(enterprise) {
    if (!enterprise || enterprise.__FLOWKIT_HOOKED__) return;
    enterprise.__FLOWKIT_HOOKED__ = true;

    if (typeof enterprise.execute === 'function' && !enterprise.execute.toString().includes('extension_hijack_detected')) {
      _realExecute = enterprise.execute;
      window.__REAL_GRECAPTCHA_EXECUTE__ = _realExecute;
    }

    let _exec = enterprise.execute;
    try {
      Object.defineProperty(enterprise, 'execute', {
        configurable: true,
        enumerable: true,
        get() {
          return _realExecute || _exec;
        },
        set(fn) {
          if (fn && fn.toString().includes('extension_hijack_detected')) {
            console.warn('[FlowKit] Neutralized extension_hijack_detected attempt in x2a!');
            return; // Discard hijack attempt!
          }
          if (typeof fn === 'function') {
            _realExecute = fn;
            _exec = fn;
            window.__REAL_GRECAPTCHA_EXECUTE__ = fn;
          }
        },
      });
    } catch (e) {
      console.warn('[FlowKit] Could not define property on enterprise:', e);
    }
  }

  function watchGrecaptcha() {
    let _g = window.grecaptcha;
    if (_g?.enterprise) {
      hookEnterprise(_g.enterprise);
    }

    try {
      Object.defineProperty(window, 'grecaptcha', {
        configurable: true,
        enumerable: true,
        get() {
          return _g;
        },
        set(val) {
          _g = val;
          if (val) {
            if (val.enterprise) {
              hookEnterprise(val.enterprise);
            } else {
              let _ent = val.enterprise;
              try {
                Object.defineProperty(val, 'enterprise', {
                  configurable: true,
                  enumerable: true,
                  get() { return _ent; },
                  set(eVal) {
                    _ent = eVal;
                    hookEnterprise(eVal);
                  },
                });
              } catch (_) {}
            }
          }
        },
      });
    } catch (e) {
      console.warn('[FlowKit] Could not define property on window.grecaptcha:', e);
    }
  }

  watchGrecaptcha();

  // TRPC fetch intercept — intercepts media URLs from labs.google
  const _origFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/fx/api/trpc/') && response.ok) {
        const clone = response.clone();
        clone.text().then((text) => {
          if (text.includes('storage.googleapis.com/ai-sandbox-videofx/')) {
            window.dispatchEvent(new CustomEvent('TRPC_MEDIA_URLS', {
              detail: { url, body: text },
            }));
          }
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  let captchaMintTail = Promise.resolve();

  async function mintCaptcha(pageAction) {
    const previous = captchaMintTail.catch(() => {});
    let release;
    captchaMintTail = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      await waitForGrecaptcha();
      const exec = _realExecute || window.__REAL_GRECAPTCHA_EXECUTE__ || window.grecaptcha?.enterprise?.execute;
      if (!exec) throw new Error('grecaptcha.enterprise.execute not available');
      return await exec.call(window.grecaptcha.enterprise, SITE_KEY, {
        action: pageAction,
      });
    } finally {
      release();
    }
  }

  window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
    const { requestId, pageAction } = detail || {};
    try {
      const token = await mintCaptcha(pageAction);
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
        detail: { requestId, token },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', {
        detail: { requestId, error: e?.message || String(e) },
      }));
    }
  });

  function waitForGrecaptcha(timeout = 22000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const has = _realExecute || window.__REAL_GRECAPTCHA_EXECUTE__ || window.grecaptcha?.enterprise?.execute;
        if (has) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
        setTimeout(check, 200);
      };
      check();
    });
  }
})();
