/**
 * The HTTP contract between the bot's `staticServer` backends and the WebUI.
 *
 * Both sides import these types, so a change to a request or response shape that
 * only one side makes fails to compile. Types-only: no runtime code, no dependencies.
 */

export * from './agents';
export * from './cluster';
export * from './common';
export * from './docs';
export * from './files';
export * from './insights';
export * from './lan';
export * from './memory';
export * from './moments';
export * from './persona';
export * from './projects';
export * from './qdrant';
export * from './reports';
export * from './stats';
export * from './tickets';
export * from './zhihu';
