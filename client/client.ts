/**
 * Browser half of dsh-stream-retry: a configuration page for the two settings the
 * classifier reads. It registers into the public `plugins.row.config` slot and uses
 * only the public settings service; no Harness Client package is imported.
 *
 * The web shell fetches this file as a classic script and concatenates several
 * bundles into one combo response, so it has to stay a script: no ESM syntax
 * anywhere, and every declaration inside the single registration factory below so
 * that nothing can collide with another bundle sharing the same response.
 * @module dsh-stream-retry/client
 */

interface Window {
  /** The shell's module-loader facade: each plugin registers one factory. */
  __ModuleLoader__: {
    load(entry: { id: string; factory(require: (name: string) => unknown): unknown }): void;
  };
}

window.__ModuleLoader__.load({
  id: 'dsh-stream-retry',
  factory(require) {
    // Type-only views of the published platform contracts. `import(...)` in a type
    // position is erased at build time, so this file keeps compiling as a script
    // instead of turning into a module with ESM syntax of its own.
    type ClientContext = import('./public.js').ClientContext;
    type ConfigForm = import('./public.js').ConfigForm;
    type ConfigFormSnapshot = import('./public.js').ConfigFormSnapshot;
    type FieldName = import('./public.js').FieldName;
    type PathOperation = import('./public.js').PathOperation;
    type ReactRuntime = import('./public.js').ReactRuntime;

    const React = require('react') as ReactRuntime;

    /** Field names in display order; `unset` operations use the same names. */
    const FIELDS: readonly FieldName[] = ['errorCodes', 'providers'];

    /** Loader row id declared by this bundle's patch. */
    const ROW_ID = 'stream-retry';

    /** The bundle id the shell registers; must match the npm package name. */
    const BUNDLE_ID = 'dsh-stream-retry';

    /** One staged settings page state. */
    interface EditorState {
      status: ConfigFormSnapshot['status'];
      writable: boolean;
      revision: number | undefined;
      errorCodes: string;
      providers: string;
      dirty: boolean;
      saving: boolean;
      error: string;
      conflict: boolean;
    }

    /** Split one textarea into identifiers, keeping an internal space like "stream error". */
    function parseList(text: string): string[] {
      return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    }

    /** Render one identifier per line. */
    function formatList(value: unknown): string {
      return Array.isArray(value) ? value.join('\n') : '';
    }

    /** Read one owned field out of an accepted section value. */
    function sectionField(value: unknown, field: FieldName): unknown {
      return (value as Record<string, unknown> | undefined)?.[field];
    }

    /** Build the display state for one accepted snapshot. */
    function seed(snapshot: ConfigFormSnapshot): EditorState {
      return {
        status: snapshot.status,
        writable: snapshot.writable,
        revision: snapshot.revision,
        errorCodes: formatList(sectionField(snapshot.value, 'errorCodes')),
        providers: formatList(sectionField(snapshot.value, 'providers')),
        dirty: false,
        saving: false,
        error: '',
        conflict: false,
      };
    }

    /**
     * Create the page editor. Edits stage locally; Save submits one revision-fenced
     * atomic mutation so a concurrent change can never be overwritten silently.
     * @param form - the shared form for this plugin's Host entry.
     * @returns the editor control surface used by the React view.
     */
    function createEditor(form: ConfigForm) {
      const listeners = new Set<() => void>();
      let accepted = form.getSnapshot();
      let baseline: number | undefined;
      let resets = new Set<FieldName>();
      let unsubscribe: (() => void) | undefined;
      let active = false;
      let state = seed(accepted);

      /** Replace the state and notify subscribers. */
      function publish(next: EditorState): void {
        state = next;
        for (const listener of listeners) listener();
      }

      /** Adopt a newly accepted snapshot, or record a conflict over a draft. */
      function refresh(): void {
        accepted = form.getSnapshot();
        if (!state.dirty && !state.saving) {
          baseline = undefined;
          resets = new Set();
          publish(seed(accepted));
          return;
        }
        publish({
          ...state,
          status: accepted.status,
          writable: accepted.writable,
          conflict: accepted.revision !== baseline,
        });
      }

      /** Whether an edit is currently allowed. */
      function canEdit(): boolean {
        return active && state.status === 'ready' && state.writable && !state.saving;
      }

      /** Remember the revision the draft started from. */
      function begin(): void {
        if (!state.dirty) baseline = accepted.revision;
      }

      return {
        getSnapshot: (): EditorState => state,
        subscribe(listener: () => void): () => void {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** Subscribe to the Host form; the returned disposer ends the page's lifetime. */
        start(): () => void {
          active = true;
          unsubscribe?.();
          unsubscribe = form.subscribe(refresh);
          refresh();
          return () => {
            active = false;
            unsubscribe?.();
            unsubscribe = undefined;
          };
        },
        /** Stage one field's text. */
        edit(field: string, text: string): void {
          if (!FIELDS.includes(field as FieldName) || !canEdit()) return;
          begin();
          resets.delete(field as FieldName);
          publish({ ...state, [field]: text, dirty: true, error: '' });
        },
        /** Stage clearing both fields back to their inherited values. */
        reset(): void {
          if (!canEdit()) return;
          begin();
          resets = new Set(FIELDS);
          const base = accepted.base;
          publish({
            ...state,
            errorCodes: formatList(sectionField(base, 'errorCodes')),
            providers: formatList(sectionField(base, 'providers')),
            dirty: true,
            error: '',
          });
        },
        /** Drop the draft and reload the accepted values. */
        discard(): void {
          if (state.saving) return;
          baseline = undefined;
          resets = new Set();
          accepted = form.getSnapshot();
          publish(seed(accepted));
        },
        /** Submit both fields in one mutation fenced by the revision the draft started from. */
        async save(): Promise<boolean> {
          if (!canEdit() || !state.dirty) return false;
          if (!Number.isSafeInteger(baseline) || state.conflict) {
            publish({ ...state, conflict: true, error: '配置已在其他页面更新。草稿已保留；请先放弃草稿并重新读取，再编辑保存。' });
            return false;
          }
          const operations: PathOperation[] = FIELDS.map((field) => (resets.has(field)
            ? { op: 'unset', path: [field] }
            : { op: 'set', path: [field], value: parseList(state[field]) }));
          publish({ ...state, saving: true, error: '' });
          try {
            const ok = await form.mutate(operations, baseline);
            if (!active) return ok;
            if (ok) {
              baseline = undefined;
              resets = new Set();
              accepted = form.getSnapshot();
              publish(seed(accepted));
            } else {
              accepted = form.getSnapshot();
              publish({
                ...state,
                saving: false,
                conflict: accepted.revision !== baseline,
                error: '保存未被接受，草稿已保留。若配置已更新，请放弃草稿后重新编辑。',
              });
            }
            return ok;
          } catch {
            if (active) publish({ ...state, saving: false, error: '无法保存配置，草稿已保留。请检查连接后重试。' });
            return false;
          }
        },
      };
    }

    const styles = {
      root: { display: 'grid', gap: 16, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      field: { display: 'grid', gap: 7 },
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
      textarea: {
        boxSizing: 'border-box', width: '100%', minHeight: 100, padding: 10,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit', lineHeight: 1.6, resize: 'vertical',
      },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      button: {
        padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
      },
      error: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.6 },
    } as const;

    /** Short description shown on the plugin card while no editor is open. */
    const summary = '为流错误分类兼容层维护标识与 provider 路由；重试仍由 DSH 官方插件执行。';

    /** Service list Cordis activates before this bundle runs. */
    const inject = ['slots', 'configForms'];

    /**
     * Mount the configuration page on the shared platform React.
     * @param ctx - client context carrying the slot registry and settings service.
     */
    function apply(ctx: ClientContext): void {
      const form = ctx.configForms.get(ROW_ID);
      const h = React.createElement;

      function EditorView({ configForm }: { configForm: ConfigForm }) {
        const [instance] = React.useState(() => createEditor(configForm));
        React.useEffect(() => instance.start(), [instance]);
        const state = React.useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot);
        if (state.status !== 'ready') {
          return h('p', { style: styles.hint, role: 'status' }, state.status === 'loading'
            ? '正在读取插件配置…'
            : '此插件当前未提供可编辑配置。');
        }
        const disabled = !state.writable || state.saving;
        function field(view: FieldName, label: string, hint: string, rows: number) {
          const id = 'dsh-stream-retry-' + view;
          return h('div', { key: view, style: styles.field },
            h('label', { htmlFor: id }, label),
            h('textarea', {
              id, rows, style: styles.textarea, value: state[view], disabled, spellCheck: false,
              'aria-describedby': id + '-hint',
              onChange: (event: { target: { value: string } }) => instance.edit(view, event.target.value),
            }),
            h('p', { id: id + '-hint', style: styles.hint }, hint));
        }
        return h('form', {
          style: styles.root,
          'aria-label': '流错误分类兼容层设置',
          'aria-busy': state.saving,
          onSubmit: (event: { preventDefault(): void }) => { event.preventDefault(); void instance.save(); },
        },
          !state.writable && h('p', { style: styles.hint, role: 'status' }, '当前连接或配置文档为只读。'),
          field('errorCodes', '错误标识',
            '每行一个，按外层错误标识精确且区分大小写匹配；空白行忽略。清空并保存即禁用此兼容层。stream error 是整个字面标识，不是正文中包含该短语就重试。每列表最多 100 项，每项最多 200 字符；不得包含首尾空白、冒号、引号、反引号或控制字符。', 5),
          field('providers', 'Provider 路由',
            '每行一个 provider 路由名称，精确且区分大小写匹配；列表为空表示所有路由。每列表最多 100 项，每项最多 200 字符，不得包含空白。此处不填写 API 地址或凭证。', 3),
          state.conflict && !state.error && h('p', { role: 'alert', style: styles.error },
            '配置已更新；为避免覆盖他人的修改，请放弃草稿后重新编辑。'),
          state.error && h('p', { role: 'alert', style: styles.error }, state.error),
          h('div', { style: styles.actions },
            h('button', {
              type: 'submit', style: styles.button,
              disabled: disabled || !state.dirty || state.conflict,
            }, state.saving ? '正在保存…' : '保存'),
            h('button', {
              type: 'button', style: styles.button,
              disabled: state.saving || !state.dirty, onClick: () => instance.discard(),
            }, '放弃草稿'),
            h('button', {
              type: 'button', style: styles.button,
              disabled, onClick: () => instance.reset(),
            }, '恢复继承值（保存后生效）')));
      }

      function ConfigView(props: Record<string, unknown>) {
        return props.view === 'summary' ? summary : h(EditorView, { configForm: props.configForm as ConfigForm });
      }

      ctx.effect(
        () => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: BUNDLE_ID + '#' + ROW_ID,
          inject: () => ({ configForm: form }),
        }, ConfigView))),
        'dsh-stream-retry: configuration page',
      );
    }

    // The shell reads named exports off the factory result, exactly like the
    // Harness' own client bundles, so the shape is an explicit namespace object.
    const exported: Record<string, unknown> = {};
    Object.defineProperty(exported, Symbol.toStringTag, { value: 'Module' });
    exported.inject = inject;
    exported.apply = apply;
    exported.createEditor = createEditor;
    exported.parseList = parseList;
    exported.summary = summary;
    return exported;
  },
});
