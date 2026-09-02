// Real login for barnyard.site, backed by a self-hosted Authentik instance
// (see ClaudeRepo/cloudflare-worker/src/index.js's "/auth/*" section).
// Renders a "Log in" / "Logged in as X · Log out" control into #auth-status,
// driven by a credentialed fetch to api.barnyard.site/auth/session -- same
// cross-origin credentialed-fetch pattern glance-widgets.js's calendar
// widget already uses for api.barnyard.site/calendar.
//
// The session cookie is shared across dashboard/study/campaign.barnyard.site
// (Domain=.barnyard.site) -- logging in here also logs you in on the other
// two, and vice versa. This widget doesn't gate anything on barnyard-hub
// itself (this page has no protected action of its own); it exists so
// there's one consistent place to see/change login state and so
// study-hub/campaign-hub's own gated actions have somewhere to send a
// logged-out visitor back to.
//
// NOTE: this file is hand-copied into barnyard-hub, study-hub, and
// campaign-hub -- none of the three has a build step, so there's no shared
// package to import it from instead. Keep changes in sync across all three
// by hand if this file ever needs to change.
(function () {
  "use strict";

  var AUTH_SESSION_API = "https://api.barnyard.site/auth/session";
  var AUTH_LOGOUT_API = "https://api.barnyard.site/auth/logout";
  var AUTH_LOGIN_URL = "https://api.barnyard.site/auth/login";
  var FETCH_TIMEOUT_MS = 10000;

  function authStatusEl() {
    return document.getElementById("auth-status");
  }

  // return_to is validated server-side against a fixed allow-list of the
  // three site origins (see validateReturnTo in the Worker) -- sending the
  // current page's own URL here is safe regardless of what this value is,
  // since the Worker never trusts it further than that check allows.
  function loginUrl() {
    return AUTH_LOGIN_URL + "?return_to=" + encodeURIComponent(location.href);
  }

  function fetchWithTimeout(url, options) {
    var controller = new AbortController();
    var timeoutId = setTimeout(function () {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    var opts = { credentials: "include", referrerPolicy: "no-referrer", signal: controller.signal };
    for (var k in options) opts[k] = options[k];
    return fetch(url, opts).finally(function () {
      clearTimeout(timeoutId);
    });
  }

  function renderLoggedOut() {
    var el = authStatusEl();
    if (!el) return;
    el.innerHTML = "";
    var a = document.createElement("a");
    a.className = "auth-login-link";
    a.href = loginUrl();
    a.textContent = "Log in";
    el.appendChild(a);
  }

  function renderLoggedIn(name, email) {
    var el = authStatusEl();
    if (!el) return;
    el.innerHTML = "";
    var label = document.createElement("span");
    label.className = "auth-status-label";
    label.textContent = "Logged in as " + (name || email || "you");
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "auth-logout-btn";
    btn.textContent = "Log out";
    btn.addEventListener("click", function () {
      logOut();
    });
    el.appendChild(label);
    el.appendChild(document.createTextNode(" · "));
    el.appendChild(btn);
  }

  // Checked once on page load. No periodic/visibility-triggered refresh --
  // session state changes rarely (a 7-day cookie), and the actual protected
  // actions on study-hub/campaign-hub are enforced server-side regardless of
  // what this widget shows, so a stale display here for the rest of one
  // page view carries no real risk.
  function checkSession() {
    return fetchWithTimeout(AUTH_SESSION_API, { method: "GET" })
      .then(function (r) {
        var contentType = r.headers.get("content-type") || "";
        if (contentType.indexOf("application/json") === -1) {
          throw new Error("unexpected content-type");
        }
        return r.json();
      })
      .then(function (data) {
        if (data && data.authenticated === true) {
          renderLoggedIn(data.name, data.email);
        } else {
          renderLoggedOut();
        }
      })
      .catch(function () {
        // Cause-neutral, same reasoning as the calendar widget's own
        // "Couldn't load your events" state -- offline, DNS, a timeout, or
        // an unexpected shape all collapse to "show logged out" here, since
        // nothing dangerous is gated behind this widget itself.
        renderLoggedOut();
      });
  }

  function logOut() {
    fetchWithTimeout(AUTH_LOGOUT_API, { method: "POST" })
      .catch(function () {
        // best-effort -- checkSession() below reflects whatever the real
        // server-side state actually is regardless of whether this specific
        // request succeeded
      })
      .then(function () {
        checkSession();
      });
  }

  function initAuthGate() {
    if (!authStatusEl()) return;
    checkSession();
  }

  // Exposed globally so a page's OWN script (e.g. study-hub's "Generate
  // revision notes" button, campaign-hub's write actions) can gate a
  // specific action behind login state without duplicating this fetch or
  // depending on the #auth-status widget existing/having already resolved.
  // Always re-fetches rather than caching indefinitely -- callers are
  // expected to call this once per thing-they're-about-to-render (e.g. at
  // page load, before building a button), not in a hot loop. Resolves to
  // { authenticated: false } on any failure, same fail-closed treatment
  // checkSession() itself uses.
  window.barnyardAuthState = function () {
    return fetchWithTimeout(AUTH_SESSION_API, { method: "GET" })
      .then(function (r) {
        var contentType = r.headers.get("content-type") || "";
        if (contentType.indexOf("application/json") === -1) {
          throw new Error("unexpected content-type");
        }
        return r.json();
      })
      .then(function (data) {
        return data && data.authenticated === true
          ? { authenticated: true, name: data.name, email: data.email }
          : { authenticated: false };
      })
      .catch(function () {
        return { authenticated: false };
      });
  };

  // Same allow-list-validated login URL checkSession()'s own "Log in" link
  // uses, exposed so a page-specific gated control (e.g. study-hub's
  // "Log in to generate notes") can send someone to the same place with the
  // same return_to behavior, without duplicating the encodeURIComponent
  // logic.
  window.barnyardLoginUrl = loginUrl;

  // Guarded on `document` existing so this file could be require()d by a
  // Node-based test without a DOM stand-in -- mirrors glance-widgets.js's
  // and live-prices.js's own guard, even though no test currently exists
  // for this file.
  if (typeof document !== "undefined") {
    initAuthGate();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { loginUrl: loginUrl };
  }
})();
