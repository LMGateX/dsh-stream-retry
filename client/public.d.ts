/**
 * Structural declarations for the browser platform this client half uses. DSH
 * injects these services and the module loader; keeping them here means nothing
 * here can change without turning into a type error, and the shipped bundle still
 * imports no Harness Client package.
 * @module dsh-stream-retry/client-types
 */
/** Field names this plugin owns inside its settings namespace. */
export type FieldName = 'errorCodes' | 'providers';
/** Snapshot of one settings namespace. */
export interface ConfigFormSnapshot {
    /** \`loading\` until the first accepted section, \`ready\` while one stands. */
    status: 'loading' | 'ready' | 'unavailable';
    /** Resolved section value, absent before the first acceptance. */
    value?: unknown;
    /** Composition layer the value was resolved over; what \`unset\` restores. */
    base?: unknown;
    /** Raw user layer, when one exists. */
    user?: unknown;
    /** Namespace revision fencing the next write. */
    revision?: number;
    /** Whether the Host document accepts writes. */
    writable: boolean;
}
/** One field operation inside an atomic namespace mutation. */
export interface PathOperation {
    op: 'set' | 'unset';
    path: readonly string[];
    value?: unknown;
}
/** Shared form values and write queue for one Host plugin entry. */
export interface ConfigForm {
    getSnapshot(): ConfigFormSnapshot;
    subscribe(listener: () => void): () => void;
    mutate(ops: readonly PathOperation[], expectedRevision?: number): Promise<boolean>;
}
/** Minimal read of the settings service this bundle consumes. */
export interface ConfigFormsService {
    get<T = unknown>(entryId: string): ConfigForm;
    whileServed(namespaces: readonly string[], register: (served: ReadonlySet<string>) => () => void): () => void;
}
/** Slot registry surface used to publish the configuration page. */
export interface SlotsService {
    inject(name: string, register: () => () => void): () => void;
    register(spec: {
        name: string;
        key: string;
        inject: () => Record<string, unknown>;
    }, component: (props: Record<string, unknown>) => unknown): () => void;
}
/** Context available to this client plugin. */
export interface ClientContext {
    slots: SlotsService;
    configForms: ConfigFormsService;
    effect(job: () => (() => void) | void, label?: string): void;
}
/** React surface this bundle is allowed to require. */
export interface ReactRuntime {
    createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown;
    useState<T>(initial: () => T): [T, (value: T) => void];
    useEffect(effect: () => (() => void) | void, deps: readonly unknown[]): void;
    useSyncExternalStore<T>(subscribe: (listener: () => void) => () => void, getSnapshot: () => T, getServerSnapshot?: () => T): T;
}
