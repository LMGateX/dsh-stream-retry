/* Browser half only. React is a platform baseline; no Harness client imports.
 * Public contracts: configForms.get/whileServed, ConfigForm.getSnapshot/subscribe/
 * mutate, and slots.inject/register. Host entry id: stream-retry.
 */
window.__ModuleLoader__.load({
  id: 'dsh-stream-retry',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const ROW_ID = 'stream-retry';
    const FIELDS = ['errorCodes', 'providers'];
    const summary = '为流错误分类兼容层维护标识与 provider 路由；重试仍由 DSH 官方插件执行。';

    function parseList(text) {
      return text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
    function formatList(value) {
      return Array.isArray(value) ? value.join('\n') : '';
    }

    // Local staging only: one atomic, revision-fenced mutation on explicit Save.
    // Preserve drafts on refusal, and never copy unknown fields into a write.
    function createEditor(form) {
      const listeners = new Set();
      let accepted = form.getSnapshot();
      let baseline;
      let resets = new Set();
      let unsubscribe;
      let active = false;
      let state = seed(accepted);
      function seed(snapshot) {
        return {
          status: snapshot.status,
          writable: snapshot.writable,
          revision: snapshot.revision,
          errorCodes: formatList(snapshot.value?.errorCodes),
          providers: formatList(snapshot.value?.providers),
          dirty: false,
          saving: false,
          error: '',
          conflict: false,
        };
      }
      function publish(next) {
        state = next;
        for (const listener of listeners) listener();
      }
      function refresh() {
        accepted = form.getSnapshot();
        if (!state.dirty && !state.saving) {
          baseline = undefined;
          resets = new Set();
          publish(seed(accepted));
        } else {
          publish({ ...state, status: accepted.status, writable: accepted.writable,
            conflict: accepted.revision !== baseline });
        }
      }
      function canEdit() {
        return active && state.status === 'ready' && state.writable && !state.saving;
      }
      function begin() {
        if (!state.dirty) baseline = accepted.revision;
      }
      return {
        getSnapshot: () => state,
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        start() {
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
        edit(field, text) {
          if (!FIELDS.includes(field) || !canEdit()) return;
          begin();
          resets.delete(field);
          publish({ ...state, [field]: text, dirty: true, error: '' });
        },
        reset() {
          if (!canEdit()) return;
          begin();
          resets = new Set(FIELDS);
          publish({ ...state,
            errorCodes: formatList(accepted.base?.errorCodes),
            providers: formatList(accepted.base?.providers),
            dirty: true, error: '' });
        },
        discard() {
          if (state.saving) return;
          baseline = undefined;
          resets = new Set();
          accepted = form.getSnapshot();
          publish(seed(accepted));
        },
        async save() {
          if (!canEdit() || !state.dirty) return false;
          if (!Number.isSafeInteger(baseline) || state.conflict) {
            publish({ ...state, conflict: true,
              error: '配置已在其他页面更新。草稿已保留；请先放弃草稿并重新读取，再编辑保存。' });
            return false;
          }
          const operations = FIELDS.map(field => resets.has(field)
            ? { op: 'unset', path: [field] }
            : { op: 'set', path: [field], value: parseList(state[field]) });
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
              publish({ ...state, saving: false,
                conflict: accepted.revision !== baseline,
                error: '保存未被接受，草稿已保留。若配置已更新，请放弃草稿后重新编辑。' });
            }
            return ok;
          } catch {
            if (active) publish({ ...state, saving: false,
              error: '无法保存配置，草稿已保留。请检查连接后重试。' });
            return false;
          }
        },
      };
    }

    const styles = {
      root: { display: 'grid', gap: 16, color: 'var(--dsw-alias-label-primary)', fontSize: 13 },
      field: { display: 'grid', gap: 7 },
      hint: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: 1.6 },
      textarea: { boxSizing: 'border-box', width: '100%', minHeight: 100, padding: 10,
        border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md)',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)',
        font: 'inherit', lineHeight: 1.6, resize: 'vertical' },
      actions: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      button: { padding: '7px 12px', border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 'var(--dsw-radius-md)', font: 'inherit',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-3)' },
      error: { margin: 0, color: 'var(--dsw-alias-label-error)', lineHeight: 1.6 },
    };
    function EditorView({ configForm }) {
      const [editor] = React.useState(() => createEditor(configForm));
      React.useEffect(() => editor.start(), [editor]);
      const state = React.useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
      if (state.status !== 'ready') {
        return h('p', { style: styles.hint, role: 'status' }, state.status === 'loading'
          ? '正在读取插件配置…' : '此插件当前未提供可编辑配置。');
      }
      const disabled = !state.writable || state.saving;
      function field(name, label, hint) {
        const id = 'dsh-stream-retry-' + name;
        return h('div', { key: name, style: styles.field },
          h('label', { htmlFor: id }, label),
          h('textarea', { id, rows: name === 'errorCodes' ? 5 : 3,
            style: styles.textarea, value: state[name], disabled, spellCheck: false,
            'aria-describedby': id + '-hint',
            onChange: event => editor.edit(name, event.target.value) }),
          h('p', { id: id + '-hint', style: styles.hint }, hint));
      }
      return h('form', { style: styles.root, 'aria-label': '流错误分类兼容层设置',
        'aria-busy': state.saving, onSubmit: event => { event.preventDefault(); void editor.save(); } },
        !state.writable && h('p', { style: styles.hint, role: 'status' }, '当前连接或配置文档为只读。'),
        field('errorCodes', '错误标识',
          '每行一个，按外层错误标识精确且区分大小写匹配；空白行忽略。清空并保存即禁用此兼容层。stream error 是整个字面标识，不是正文中包含该短语就重试。每列表最多 100 项，每项最多 200 字符；不得包含首尾空白、冒号、引号、反引号或控制字符。'),
        field('providers', 'Provider 路由',
          '每行一个 provider 路由名称，精确且区分大小写匹配；列表为空表示所有路由。每列表最多 100 项，每项最多 200 字符，不得包含空白。此处不填写 API 地址或凭证。'),
        state.conflict && !state.error && h('p', { role: 'alert', style: styles.error },
          '配置已更新；为避免覆盖他人的修改，请放弃草稿后重新编辑。'),
        state.error && h('p', { role: 'alert', style: styles.error }, state.error),
        h('div', { style: styles.actions },
          h('button', { type: 'submit', style: styles.button,
            disabled: disabled || !state.dirty || state.conflict }, state.saving ? '正在保存…' : '保存'),
          h('button', { type: 'button', style: styles.button,
            disabled: state.saving || !state.dirty, onClick: () => editor.discard() }, '放弃草稿'),
          h('button', { type: 'button', style: styles.button,
            disabled, onClick: () => editor.reset() }, '恢复继承值（保存后生效）')));
    }
    function ConfigView(props) {
      return props.view === 'summary' ? summary : h(EditorView, { configForm: props.configForm });
    }
    function apply(ctx) {
      const form = ctx.configForms.get(ROW_ID);
      ctx.effect(() => ctx.configForms.whileServed([ROW_ID], () =>
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config', key: 'dsh-stream-retry#' + ROW_ID,
          inject: () => ({ configForm: form }),
        }, ConfigView))), 'dsh-stream-retry: configuration page');
    }
    return { inject: ['slots', 'configForms'], apply, parseList, createEditor };
  },
});
