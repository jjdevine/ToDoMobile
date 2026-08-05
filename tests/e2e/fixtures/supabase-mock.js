/**
 * Mock Supabase UMD module.
 *
 * Playwright intercepts the CDN request for @supabase/supabase-js and serves
 * this file instead. It sets window.supabase = { createClient } so the app
 * initialises normally with a fully controlled, in-process mock.
 *
 * Tests interact with the mock via window.__sb:
 *   window.__sb.state          – mutable fixture data
 *   window.__sb.calls          – log of every API call made
 *   window.__sb.authListeners  – registered onAuthStateChange callbacks
 *   window.__sb.triggerAuth(event, session) – fire auth events from tests
 */
(function (root) {
  "use strict";

  // ──────────────────────────────────────────────────────────────────────────
  // Global mock handle (tests read/write this via page.evaluate)
  // Uses window.__sbInitialState if pre-seeded by addInitScript, otherwise
  // falls back to empty defaults.
  // ──────────────────────────────────────────────────────────────────────────
  var defaultState = {
    user: null,
    tables: {
      user_settings: [],
      projects: [],
      tasks: [],
      archived_tasks: [],
      generated_occurrences: [],
      tags: [],
      project_tags: [],
      recurring_task_descriptions: [],
    },
  };

  root.__sb = {
    state: root.__sbInitialState || defaultState,
    calls: [],
    authListeners: [],

    triggerAuth: function (event, session) {
      root.__sb.authListeners.forEach(function (cb) {
        cb(event, session);
      });
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Call logger
  // ──────────────────────────────────────────────────────────────────────────
  function log(type, table, payload) {
    root.__sb.calls.push({ type: type, table: table, payload: payload });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Chainable query builder
  // ──────────────────────────────────────────────────────────────────────────
  function makeBuilder(tableNameOrNull, initialData) {
    var b = {
      _table: tableNameOrNull,
      _data: initialData,
      _single: false,
      _writeResult: undefined,

      // ── Read modifiers (return this for chaining) ──────────────────────
      select: function () { return this; },
      order: function () { return this; },
      limit: function (n) {
        if (Array.isArray(this._data)) {
          this._data = this._data.slice(0, n);
        }
        return this;
      },
      eq: function (col, val) {
        // Filter only when data is an array (read queries); write builders
        // set _writeResult, so filtering doesn't apply.
        if (this._writeResult === undefined && Array.isArray(this._data)) {
          this._data = this._data.filter(function (row) {
            return row[col] === val;
          });
        }
        return this;
      },
      maybeSingle: function () {
        this._single = true;
        return this;
      },

      // ── Write operations ───────────────────────────────────────────────
      insert: function (payload) {
        log("insert", this._table, payload);
        return makeWriteBuilder(this._table);
      },
      upsert: function (payload, opts) {
        log("upsert", this._table, { payload: payload, opts: opts });
        return makeWriteBuilder(this._table);
      },
      update: function (payload) {
        log("update", this._table, payload);
        return makeWriteBuilder(this._table);
      },
      delete: function () {
        log("delete", this._table, null);
        return makeWriteBuilder(this._table);
      },

      // ── Promise interface ──────────────────────────────────────────────
      then: function (resolve, reject) {
        var result;
        if (this._writeResult !== undefined) {
          result = this._writeResult;
        } else if (this._single) {
          var arr = Array.isArray(this._data) ? this._data : [];
          result = { data: arr.length > 0 ? arr[0] : null, error: null };
        } else {
          result = { data: Array.isArray(this._data) ? this._data : [], error: null };
        }
        return Promise.resolve(result).then(resolve, reject);
      },
      catch: function (reject) {
        return this.then(undefined, reject);
      },
    };
    return b;
  }

  function makeWriteBuilder(tableName) {
    var b = makeBuilder(tableName, null);
    b._writeResult = { data: null, error: null };
    return b;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Table router  –  returns rows for the given table name
  // ──────────────────────────────────────────────────────────────────────────
  function tableData(name) {
    var tables = root.__sb.state.tables;
    // Map Supabase table names to mock state keys
    var key = name
      .replace(/^todo\./, "")
      .toLowerCase();
    // Handle the user_settings table which should return a single row
    return tables[key] ? tables[key].slice() : [];
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Schema & table builder
  // ──────────────────────────────────────────────────────────────────────────
  function makeSchemaProxy(_schemaName) {
    return {
      from: function (tableName) {
        log("read", tableName, null);
        var data = tableData(tableName);
        var b = makeBuilder(tableName, data);
        // Provide RPC on the schema level too (Supabase: schema().rpc())
        b.rpc = function (fnName, args) {
          return makeRpcBuilder(fnName, args);
        };
        return b;
      },
      rpc: function (fnName, args) {
        return makeRpcBuilder(fnName, args);
      },
    };
  }

  function makeRpcBuilder(fnName, args) {
    log("rpc", fnName, args);
    // Return value: generate_recurring_tasks returns an integer, complete_task returns null
    var returnVal = fnName === "generate_recurring_tasks" ? 0 : null;
    var b = makeBuilder(fnName, null);
    b._writeResult = { data: returnVal, error: null };
    return b;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Auth mock
  // ──────────────────────────────────────────────────────────────────────────
  var auth = {
    getSession: function () {
      var user = root.__sb.state.user;
      if (user) {
        return Promise.resolve({ data: { session: { user: user, access_token: "mock-token" } }, error: null });
      }
      return Promise.resolve({ data: { session: null }, error: null });
    },

    onAuthStateChange: function (cb) {
      root.__sb.authListeners.push(cb);
      return { data: { subscription: { unsubscribe: function () {} } } };
    },

    signInWithPassword: function (creds) {
      log("auth.signIn", null, { email: creds.email });
      var user = root.__sb.state.user;
      if (user && user.email === creds.email) {
        var session = { user: user, access_token: "mock-token" };
        setTimeout(function () {
          root.__sb.triggerAuth("SIGNED_IN", session);
        }, 0);
        return Promise.resolve({ data: { session: session, user: user }, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "Invalid login credentials" } });
    },

    signOut: function () {
      log("auth.signOut", null, null);
      root.__sb.state.user = null;
      setTimeout(function () {
        root.__sb.triggerAuth("SIGNED_OUT", null);
      }, 0);
      return Promise.resolve({ error: null });
    },
  };

  // ──────────────────────────────────────────────────────────────────────────
  // createClient factory
  // ──────────────────────────────────────────────────────────────────────────
  function createClient(_url, _key, _opts) {
    return {
      auth: auth,
      schema: function (name) {
        return makeSchemaProxy(name);
      },
    };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // UMD export – mirrors what the real CDN module sets
  // ──────────────────────────────────────────────────────────────────────────
  root.supabase = { createClient: createClient };
})(typeof globalThis !== "undefined" ? globalThis : this);
