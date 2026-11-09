/* Empyrean Navigation v1. Dependency-free; also bundled inline in opaque modules.
 * Source of truth: Nexus. Sync vendored copies with scripts/sync-navigation.mjs.
 * No API credentials, module domain state or draft text belongs in route URLs.
 */
(() => {
  const channel = 'empyrean-navigation-v1';
  // getRandomValues also works on existing HTTP LAN installations; randomUUID
  // would require a secure context and break feature-disabled legacy modules.
  const nonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    value => value.toString(16).padStart(2,'0')).join('');
  const bytes = value => new TextEncoder().encode(value).length;
  function route(value) {
    if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') ||
        bytes(value) > 2048 || /[\s\\\u0000-\u001f\u007f]/u.test(value) || /%(?![a-f\d]{2})/i.test(value))
      throw Error('Invalid navigation route');
    const path = value.split(/[?#]/, 1)[0];
    let decoded;
    try { decoded = decodeURIComponent(path); } catch { throw Error('Invalid route encoding'); }
    if (/[\\\u0000-\u0020\u007f]/u.test(decoded) || /%2f|%5c/i.test(path) ||
        decoded.split('/').some(part => part === '.' || part === '..')) throw Error('Invalid route path');
    return value;
  }
  function envelope(search) {
    const params = new URLSearchParams(search);
    if (!params.has('nav') && !params.has('route')) return null;
    if (['path', 'nav', 'route'].some(key => params.getAll(key).length > 1) ||
        params.get('nav') !== '1' || !params.has('route')) throw Error('Invalid navigation envelope');
    return route(params.get('route'));
  }
  function urlFor(input, value) {
    const url = new URL(input);
    url.searchParams.set('nav', '1');
    url.searchParams.set('route', route(value));
    return url.pathname + url.search + url.hash;
  }
  function createHost({ active, current, commit, report, storage, owner }) {
    if (!storage) {
      try { storage = window.sessionStorage; }
      catch { storage = {getItem:() => null, setItem:() => {throw Error('Storage unavailable');}, length:0}; }
    }
    let binding = null;
    const key = module => 'nexus.navigation.drafts.v1:' + owner() + ':' + module;
    const viewsKey = scope => 'nexus.navigation.views.v1:' + owner() + ':' + scope;
    function snapshot(module) {
      try { return JSON.parse(storage.getItem(key(module)) || 'null'); } catch { return null; }
    }
    function post(message) {
      if (binding?.frame.isConnected) binding.frame.contentWindow.postMessage({channel, ...message}, '*');
    }
    /* Private per-history-entry view state (filters, loaded range, scroll). The browser entry
     * holds only an opaque id; the value stays in this tab's storage, never in a URL. */
    function currentEntry() {
      try {
        const existing = history.state?.nexusNavigation?.entry;
        if (typeof existing === 'string') return existing;
        const entry = nonce();
        history.replaceState({...history.state, nexusNavigation:{version:1, entry}}, '', location.pathname + location.search + location.hash);
        return entry;
      } catch { return null; }
    }
    function readViews(scope) {
      try { return JSON.parse(storage.getItem(viewsKey(scope)) || '{}') || {}; } catch { return {}; }
    }
    function readEntryView(scope, entry = currentEntry()) { return entry ? readViews(scope)[entry] ?? null : null; }
    function writeEntryView(scope, entry, value) {
      if (!entry || !value || typeof value !== 'object' || Array.isArray(value)) return;
      try {
        if (bytes(JSON.stringify(value)) > 16 * 1024) return;
        const views = readViews(scope);
        delete views[entry]; views[entry] = value; // insertion order: oldest entries are dropped first
        for (const old of Object.keys(views).slice(0, -40)) delete views[old];
        storage.setItem(viewsKey(scope), JSON.stringify(views));
      } catch { /* view restoration is best effort and never blocks navigation */ }
    }
    function restore(cause = 'traversal') {
      if (!binding?.document) return;
      clearTimeout(binding.timer);
      const target = current();
      binding.leaving = false;
      binding.cause = cause;
      binding.entry = currentEntry();
      post({type:'restore', document:binding.document, session:binding.session,
        revision:++binding.revision, route:target.navigationRoute ?? target.modulePath,
        legacy:target.navigationRoute === undefined, cause,
        ...(cause === 'commit' ? {} : {viewState:readEntryView(binding.module, binding.entry)}),
        ...(cause === 'initial' ? {checkpoint:snapshot(binding.module)} : {})});
      const revision = binding.revision;
      binding.timer = setTimeout(() => {
        if (binding?.revision === revision) report('The application has not restored this view. Reload to retry.');
      }, 20000);
    }
    function bind(frame, module) {
      if (binding?.frame === frame && binding.module === module) return;
      clearTimeout(binding?.timer);
      binding?.frame.removeEventListener?.('load', binding.loaded);
      binding = {frame, module, revision:0, windowStart:Date.now(), count:0,challenge:nonce()};
      binding.loaded = () => {
        if (binding?.frame !== frame) return;
        clearTimeout(binding.timer);
        binding.challenge = nonce(); binding.document = null; binding.session = null;
        post({type:'probe',challenge:binding.challenge});
      };
      frame.addEventListener?.('load', binding.loaded);
    }
    function reset() {
      clearTimeout(binding?.timer);
      clearTimeout(binding?.leavingTimer);
      binding?.leave?.resolve();
      binding?.frame.removeEventListener?.('load', binding.loaded);
      binding = null; report('');
    }
    function reject(code) {
      post({type:'reject',session:binding.session,revision:binding.revision,code});
    }
    function receive(event) {
      if (!binding || !binding.frame.isConnected || event.source !== binding.frame.contentWindow ||
          !active(binding.module)) return;
      const m = event.data;
      if (!m || typeof m !== 'object' || m.channel !== channel) return;
      if (m.type === 'hello') {
        if (m.version !== 1 || typeof m.document !== 'string' || !/^[\w-]{1,100}$/.test(m.document)) return;
        if (m.challenge !== binding.challenge) { post({type:'probe',challenge:binding.challenge}); return; }
        if (binding.document !== m.document) {
          binding.document = m.document; binding.session = nonce();
        }
        restore('initial');
        return;
      }
      if (!binding.document || m.session !== binding.session) return;
      if (m.type === 'prepared') {
        if (!binding.leave || m.id !== binding.leave.id) return;
        clearTimeout(binding.leavingTimer);
        const pending = binding.leave; binding.leave = null;
        if (m.error) { binding.leaving = false; pending.reject(Error('Draft checkpoint failed. The editor remains open for recovery.')); }
        else { writeEntryView(binding.module, binding.entry, m.viewState); pending.resolve(); }
        return;
      }
      if (m.type === 'view-state') {
        if (m.revision !== binding.revision || binding.leaving) return;
        if (!binding.viewStart || Date.now() - binding.viewStart > 1000) { binding.viewStart = Date.now(); binding.viewCount = 0; }
        if (++binding.viewCount <= 20) writeEntryView(binding.module, binding.entry, m.value);
        return;
      }
      if (m.type === 'checkpoint') {
        if (!Number.isSafeInteger(m.id) || m.id < 1) return;
        if (!binding.checkpointStart || Date.now() - binding.checkpointStart > 1000) {
          binding.checkpointStart = Date.now(); binding.checkpointCount = 0;
        }
        if (++binding.checkpointCount > 100) {
          post({type:'checkpointed',session:binding.session,id:m.id,error:'Draft checkpoints are arriving too quickly. Save before leaving.'});
          return;
        }
        try {
          if (!m.value || typeof m.value !== 'object' || Array.isArray(m.value)) throw Error('Invalid checkpoint');
          const serialized = JSON.stringify(m.value);
          if (bytes(serialized) > 1024 * 1024) throw Error('Draft checkpoint too large');
          storage.setItem(key(binding.module), serialized);
          post({type:'checkpointed',session:binding.session,id:m.id});
        } catch { post({type:'checkpointed',session:binding.session,id:m.id,error:'Draft recovery storage is unavailable or full. Save before leaving.'}); }
        return;
      }
      if (m.type === 'applied') {
        if (m.revision !== binding.revision || !['ok','not-found','error'].includes(m.status)) return;
        clearTimeout(binding.timer);
        // 'not-found' means the module is already showing its own explicit outcome.
        // A resume follows a refused leave: its explanation stays until the next real navigation.
        if (m.status === 'error') report('The application could not open this view. The address has been retained.');
        else if (binding.cause !== 'resume') report('');
        return;
      }
      if (m.type !== 'commit') return;
      if (binding.leaving) return reject('leaving');
      if (Date.now() - binding.windowStart > 1000) { binding.windowStart = Date.now(); binding.count = 0; }
      if (++binding.count > 40) return reject('rate-limit');
      if (m.baseRevision !== binding.revision) { reject('stale'); restore('resync'); return; }
      try {
        if (!['push','replace'].includes(m.mode)) throw Error('Invalid history mode');
        const next = urlFor(location.href, m.route);
        const previous = location.pathname + location.search + location.hash;
        writeEntryView(binding.module, binding.entry, m.viewState);
        if (next !== previous) {
          // A replaced entry keeps its identity; a pushed one starts with no view state.
          const entry = m.mode === 'replace' && binding.entry ? binding.entry : nonce();
          history[m.mode === 'push' ? 'pushState' : 'replaceState'](
            {...history.state, nexusNavigation:{version:1, entry}}, '', next);
          commit(m.route);
        }
        restore('commit');
      } catch { reject('invalid-route'); }
    }
    function prepareLeave() {
      if (!binding?.document || !active(binding.module)) return Promise.resolve();
      if (binding.leave) return binding.leave.promise;
      let resolve, reject;
      const promise = new Promise((ok, fail) => {resolve=ok;reject=fail;});
      const id = nonce();
      binding.leave = {id,promise,resolve,reject}; binding.leaving = true;
      binding.leavingTimer = setTimeout(() => {
        if (!binding?.leave || binding.leave.id !== id) return;
        binding.leave = null; binding.leaving = false;
        reject(Error('The application could not checkpoint its drafts. Its editor remains open.'));
      }, 5000);
      post({type:'prepare-leave',session:binding.session,revision:++binding.revision,id});
      return promise;
    }
    function hasDrafts() {
      const prefix = 'nexus.navigation.drafts.v1:' + owner() + ':';
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name?.startsWith(prefix)) {
          try { if (JSON.parse(storage.getItem(name))?.dirty === true) return true; } catch { /* no readable checkpoint */ }
        }
      }
      return false;
    }
    return {bind, restore, reset, receive, prepareLeave, hasDrafts, currentEntry, readEntryView, writeEntryView,
      clearModuleDrafts(module) { storage.removeItem?.(key(module)); storage.removeItem?.(viewsKey(module)); }, clearDrafts() {
      for (const prefix of ['nexus.navigation.drafts.v1:', 'nexus.navigation.views.v1:'].map(name => name + owner() + ':'))
        for (let i = storage.length - 1; i >= 0; i--) {
          const name = storage.key(i); if (name?.startsWith(prefix)) storage.removeItem(name);
        }
    }};
  }
  function createClient({ apply, invalidate = () => {}, onError = () => {}, beforeLeave = async () => {}, captureView = null }) {
    const documentId = nonce();
    const parentOrigin = (() => { try { return new URL(document.referrer).origin; } catch { return location.origin; } })();
    // idle → handshaking → ready, or handshaking → failed (start() may be retried), or unsupported.
    let phase = 'idle', session, revision = 0, target, draining = false, intent, initial, currentRoute, challenge;
    let receipt = 0;
    let sequence = 0, helloTimer, helloAttempts = 0, starting = null, viewTimer;
    const checkpoints = new Map();
    const post = data => parent.postMessage({channel, ...data}, parentOrigin);
    function failure(error) { onError(error); return error; }
    /** The module's private state for the entry on screen; never read while a restore is applying. */
    function view() {
      if (!captureView || draining) return undefined;
      try { return captureView() || undefined; } catch { return undefined; }
    }
    function viewChanged() {
      if (!captureView || phase !== 'ready') return;
      clearTimeout(viewTimer);
      viewTimer = setTimeout(() => {
        const value = view();
        if (value && session) post({type:'view-state',session,revision,value});
      }, 300);
    }
    if (captureView) window.addEventListener('scroll', viewChanged, {capture:true, passive:true});
    function failStart(error) {
      clearInterval(helloTimer);
      phase = 'failed'; session = undefined; revision = 0; target = null; ++receipt;
      intent?.reject(error); intent = null;
      for (const pending of checkpoints.values()) { clearTimeout(pending.timer); pending.reject(error); }
      checkpoints.clear();
      const waiting = initial; initial = null; starting = null;
      waiting?.reject(error);
    }
    async function drain() {
      if (draining) return;
      draining = true;
      while (target) {
        const message = target; target = null;
        const token = receipt;
        const isCurrent = () => token === receipt && message.revision === revision && message.session === session;
        let status = 'ok';
        // apply() throws on failure; it returns 'not-found' after rendering its own outcome.
        try { if (await apply(message.route, {...message, isCurrent}) === 'not-found') status = 'not-found'; }
        catch (error) { status = 'error'; if (isCurrent()) failure(error); }
        if (!isCurrent()) continue;
        post({type:'applied',session,revision,status});
        initial?.resolve({...message, status}); initial = null;
        if (intent && message.cause === 'commit') { intent.resolve({...message, status}); intent = null; }
      }
      draining = false;
    }
    window.addEventListener('message', event => {
      const m = event.data;
      if ((phase !== 'handshaking' && phase !== 'ready') || event.source !== parent || event.origin !== parentOrigin || m?.channel !== channel) return;
      if (m.type === 'prepare-leave' && m.session === session) {
        if (!Number.isSafeInteger(m.revision) || m.revision <= revision || typeof m.id !== 'string') return;
        const captured = view();
        revision = m.revision; ++receipt;
        intent?.reject(Error('Navigation superseded')); intent = null;
        invalidate();
        Promise.resolve().then(beforeLeave).then(
          () => post({type:'prepared',session,id:m.id,...(captured ? {viewState:captured} : {})}),
          () => post({type:'prepared',session,id:m.id,error:true}));
      } else if (m.type === 'probe') {
        if (typeof m.challenge !== 'string' || !/^[\w-]{1,100}$/.test(m.challenge)) return;
        if (challenge !== m.challenge) {
          challenge = m.challenge; session = undefined; revision = 0; ++receipt;
          intent?.reject(Error('Application document changed')); intent = null;
        }
        post({type:'hello',version:1,document:documentId,challenge});
      } else if (m.type === 'restore') {
        if (m.document !== documentId || typeof m.session !== 'string' ||
            (session && session !== m.session) || !Number.isSafeInteger(m.revision) || m.revision <= revision) return;
        try { route(m.route); } catch { return; }
        session = m.session; revision = m.revision; currentRoute = m.route; ++receipt;
        clearInterval(helloTimer); phase = 'ready';
        if (intent && m.cause !== 'commit') { intent.reject(Error('Navigation superseded')); intent = null; }
        invalidate(); target = m; void drain();
      } else if (m.session === session && m.type === 'reject') {
        intent?.reject(Error('Navigation rejected: ' + m.code)); intent = null;
      } else if (m.session === session && m.type === 'checkpointed') {
        const pending = checkpoints.get(m.id);
        if (!pending) return;
        clearTimeout(pending.timer); checkpoints.delete(m.id);
        if (m.error) pending.reject(failure(Error(m.error))); else pending.resolve();
      }
    });
    function timeout(pending, label) {
      pending.timer = setTimeout(() => pending.reject(failure(Error(label))), 10000);
    }
    return {
      /** True only once the host has granted a session; false again after a failed handshake. */
      get enabled() { return phase === 'ready'; },
      get status() { return phase; },
      get revision() { return revision; },
      get route() { return currentRoute; },
      /** Resolves true when negotiated, false on an unsupported host, and rejects on timeout. Safe to
       * call again after a rejection: each attempt starts from a clean state. */
      start(context) {
        if (phase === 'ready') return Promise.resolve(true);
        if (!context?.navigation?.versions?.includes(1) || parent === window) { phase = 'unsupported'; return Promise.resolve(false); }
        if (starting) return starting;
        phase = 'handshaking'; session = undefined; revision = 0; helloAttempts = 0; target = null; ++receipt;
        starting = new Promise((resolve, reject) => { initial = {resolve,reject}; }).then(() => { starting = null; return true; });
        const hello = () => {
          if (++helloAttempts > 5) { failStart(Error('Navigation handshake timed out')); return; }
          post({type:'hello',version:1,document:documentId,challenge});
        };
        helloTimer = setInterval(hello, 500); hello();
        return starting;
      },
      navigate(value, mode = 'push') {
        route(value);
        if (phase !== 'ready' || !session) return Promise.reject(Error('Navigation is not ready'));
        // One outstanding intent. Never rebase an obsolete intent after traversal.
        if (intent) return Promise.reject(Error('Navigation is already pending'));
        return new Promise((resolve, reject) => {
          const pending = {resolve: value => {clearTimeout(pending.timer); resolve(value);},
            reject: error => {clearTimeout(pending.timer); if (intent === pending) intent = null; reject(error);}};
          intent = pending; timeout(pending, 'Navigation acknowledgment timed out');
          const captured = view();
          post({type:'commit',session,baseRevision:revision,route:value,mode,...(captured ? {viewState:captured} : {})});
        });
      },
      /** Tell the host that the private view state of the entry on screen changed (debounced). */
      viewChanged,
      checkpoint(value) {
        if (phase !== 'ready' || !session) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const id = ++sequence, pending = {resolve,reject};
          checkpoints.set(id, pending); timeout(pending, 'Draft checkpoint timed out');
          post({type:'checkpoint',session,id,value});
        });
      },
    };
  }
  globalThis.EmpyreanNavigation = Object.freeze({version:1, channel, route, envelope, urlFor, createHost, createClient});
})();
