// js/types.js — JSDoc typedefs for IDE/static checking only.
// Runtime exports are intentionally empty.

/**
 * @typedef {Object} Settings
 * @property {boolean=} tickets_enabled
 * @property {boolean=} tickets_unlocked
 * @property {boolean=} show_bookmarks_tab
 * @property {boolean=} show_history_tab
 * @property {string=} theme_mode
 * @property {string=} accent_color
 * @property {string=} user_profile_mode
 * @property {number=} interval
 */

/**
 * @typedef {Object} Topic
 * @property {string|number} id
 * @property {string} title
 * @property {string=} url
 * @property {boolean=} viewed
 * @property {number=} count
 * @property {number=} unread_count
 * @property {string=} section
 */

/**
 * @typedef {Object} Dialog
 * @property {string|number} id
 * @property {string=} title
 * @property {string=} name
 * @property {string|number=} opponent_id
 * @property {number=} count
 * @property {boolean=} viewed
 */

/**
 * @typedef {Object} Mention
 * @property {string|number} id
 * @property {string|number=} topic_id
 * @property {string|number=} post_id
 * @property {string=} title
 * @property {string=} author
 * @property {boolean=} viewed
 */

/**
 * @typedef {Object} Ticket
 * @property {string|number} id
 * @property {string=} title
 * @property {string=} author
 * @property {string=} status
 * @property {boolean=} viewed
 */

/**
 * @typedef {Object} DiagnosticsSnapshot
 * @property {boolean} ok
 * @property {string} version
 * @property {boolean} authorized
 * @property {Object} health
 * @property {Object} counts
 * @property {Settings} settings
 */

/**
 * @typedef {Object} AppState
 * @property {Settings} settings
 * @property {{count:number,list:Topic[]}=} favorites
 * @property {{count:number,list:Dialog[]}=} qms
 * @property {{count:number,list:Mention[]}=} mentions
 * @property {{count:number,list:Ticket[]}=} tickets
 */

export {};
