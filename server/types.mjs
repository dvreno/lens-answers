// Shared JSDoc typedefs. No runtime exports.

/** @typedef {{kind:'pause'|'question'|'none', route?:'work'|'statute'|'project'|'web'|'general',
 *   query?:string, chapters?:string[], section?:string}} Intent */
/** @typedef {{label:string, text:string}} Passage */
/** @typedef {{passages:Passage[]}} SourceResult */
/** @typedef {{id:number, heard:string, source:string, answer:string, solid:boolean, ttlMs:number}} Card */
/** @typedef {{complete(req:{model:'fast'|'answer'|'work', system:string, user:string, maxTokens:number,
 *   webSearch?:boolean}): Promise<{text:string, sources:string[]}>, close?(): void}} Llm */

export {};

/** @typedef {ReturnType<typeof import('./config.mjs').defaults>} Config */
