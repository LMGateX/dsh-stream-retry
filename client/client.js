/** Field names in display order; \`unset\` operations use the same names. */
const FIELDS = ['errorCodes', 'providers'];
/** Loader row id declared by this bundle's patch. */
const ROW_ID = 'stream-retry';
/** The bundle id the shell registers; must match the npm package name. */
const BUNDLE_ID = 'dsh-stream-retry';
/** Split one textarea into identifiers, keeping an internal space like "stream error". */
export function parseList(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}
/** Render one identifier per line. */
export function formatList(value) {
    return Array.isArray(value) ? value.join('\n') : '';
}
/** Read one owned field out of an accepted section value. */
function sectionField(value, field) {
    return value?.[field];
}
/** Build the display state for one accepted snapshot. */
function seed(snapshot) {
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
export function createEditor(form) {
    const listeners = new Set();
    let accepted = form.getSnapshot();
    let baseline;
    let resets = new Set();
    let unsubscribe;
    let active = false;
    let state = seed(accepted);
    /** Replace the state and notify subscribers. */
    function publish(next) {
        state = next;
        for (const listener of listeners)
            listener();
    }
    /** Adopt a newly accepted snapshot, or record a conflict over a draft. */
    function refresh() {
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
    function canEdit() {
        return active && state.status === 'ready' && state.writable && !state.saving;
    }
    /** Remember the revision the draft started from. */
    function begin() {
        if (!state.dirty)
            baseline = accepted.revision;
    }
    return {
        getSnapshot: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        /** Subscribe to the Host form; the returned disposer ends the page's lifetime. */
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
        /** Stage one field's text. */
        edit(field, text) {
            if (!FIELDS.includes(field) || !canEdit())
                return;
            begin();
            resets.delete(field);
            publish({ ...state, [field]: text, dirty: true, error: '' });
        },
        /** Stage clearing both fields back to their inherited values. */
        reset() {
            if (!canEdit())
                return;
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
        discard() {
            if (state.saving)
                return;
            baseline = undefined;
            resets = new Set();
            accepted = form.getSnapshot();
            publish(seed(accepted));
        },
        /** Submit both fields in one mutation fenced by the revision the draft started from. */
        async save() {
            if (!canEdit() || !state.dirty)
                return false;
            if (!Number.isSafeInteger(baseline) || state.conflict) {
                publish({ ...state, conflict: true, error: '配置已在其他页面更新。草稿已保留；请先放弃草稿并重新读取，再编辑保存。' });
                return false;
            }
            const operations = FIELDS.map((field) => (resets.has(field)
                ? { op: 'unset', path: [field] }
                : { op: 'set', path: [field], value: parseList(state[field]) }));
            publish({ ...state, saving: true, error: '' });
            try {
                const ok = await form.mutate(operations, baseline);
                if (!active)
                    return ok;
                if (ok) {
                    baseline = undefined;
                    resets = new Set();
                    accepted = form.getSnapshot();
                    publish(seed(accepted));
                }
                else {
                    accepted = form.getSnapshot();
                    publish({
                        ...state,
                        saving: false,
                        conflict: accepted.revision !== baseline,
                        error: '保存未被接受，草稿已保留。若配置已更新，请放弃草稿后重新编辑。',
                    });
                }
                return ok;
            }
            catch {
                if (active)
                    publish({ ...state, saving: false, error: '无法保存配置，草稿已保留。请检查连接后重试。' });
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
};
/** Short description shown on the plugin card while no editor is open. */
export const summary = '为流错误分类兼容层维护标识与 provider 路由；重试仍由 DSH 官方插件执行。';
/** Service list Cordis activates before this bundle runs. */
export const inject = ['slots', 'configForms'];
/**
 * Mount the configuration page on the shared platform React.
 * @param ctx - client context carrying the slot registry and settings service.
 * @param React - the platform React runtime, required by the loader factory.
 */
export function apply(ctx, React) {
    const form = ctx.configForms.get(ROW_ID);
    const h = React.createElement;
    function EditorView({ configForm }) {
        const [instance] = React.useState(() => createEditor(configForm));
        React.useEffect(() => instance.start(), [instance]);
        const state = React.useSyncExternalStore(instance.subscribe, instance.getSnapshot, instance.getSnapshot);
        if (state.status !== 'ready') {
            return h('p', { style: styles.hint, role: 'status' }, state.status === 'loading'
                ? '正在读取插件配置…'
                : '此插件当前未提供可编辑配置。');
        }
        const disabled = !state.writable || state.saving;
        function field(view, label, hint, rows) {
            const id = 'dsh-stream-retry-' + view;
            return h('div', { key: view, style: styles.field }, h('label', { htmlFor: id }, label), h('textarea', {
                id, rows, style: styles.textarea, value: state[view], disabled, spellCheck: false,
                'aria-describedby': id + '-hint',
                onChange: (event) => instance.edit(view, event.target.value),
            }), h('p', { id: id + '-hint', style: styles.hint }, hint));
        }
        return h('form', {
            style: styles.root,
            'aria-label': '流错误分类兼容层设置',
            'aria-busy': state.saving,
            onSubmit: (event) => { event.preventDefault(); void instance.save(); },
        }, !state.writable && h('p', { style: styles.hint, role: 'status' }, '当前连接或配置文档为只读。'), field('errorCodes', '错误标识', '每行一个，按外层错误标识精确且区分大小写匹配；空白行忽略。清空并保存即禁用此兼容层。stream error 是整个字面标识，不是正文中包含该短语就重试。每列表最多 100 项，每项最多 200 字符；不得包含首尾空白、冒号、引号、反引号或控制字符。', 5), field('providers', 'Provider 路由', '每行一个 provider 路由名称，精确且区分大小写匹配；列表为空表示所有路由。每列表最多 100 项，每项最多 200 字符，不得包含空白。此处不填写 API 地址或凭证。', 3), state.conflict && !state.error && h('p', { role: 'alert', style: styles.error }, '配置已更新；为避免覆盖他人的修改，请放弃草稿后重新编辑。'), state.error && h('p', { role: 'alert', style: styles.error }, state.error), h('div', { style: styles.actions }, h('button', {
            type: 'submit', style: styles.button,
            disabled: disabled || !state.dirty || state.conflict,
        }, state.saving ? '正在保存…' : '保存'), h('button', {
            type: 'button', style: styles.button,
            disabled: state.saving || !state.dirty, onClick: () => instance.discard(),
        }, '放弃草稿'), h('button', {
            type: 'button', style: styles.button,
            disabled, onClick: () => instance.reset(),
        }, '恢复继承值（保存后生效）')));
    }
    function ConfigView(props) {
        return props.view === 'summary' ? summary : h(EditorView, { configForm: props.configForm });
    }
    ctx.effect(() => ctx.configForms.whileServed([ROW_ID], () => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: BUNDLE_ID + '#' + ROW_ID,
        inject: () => ({ configForm: form }),
    }, ConfigView))), 'dsh-stream-retry: configuration page');
}
window.__ModuleLoader__.load({
    id: BUNDLE_ID,
    factory(require) {
        const React = require('react');
        return {
            inject,
            apply: (ctx) => apply(ctx, React),
            createEditor,
            parseList,
            summary,
        };
    },
});
//# sourceMappingURL=client.js.map