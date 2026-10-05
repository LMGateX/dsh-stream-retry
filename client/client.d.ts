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
        load(entry: {
            id: string;
            factory(require: (name: string) => unknown): unknown;
        }): void;
    };
}
