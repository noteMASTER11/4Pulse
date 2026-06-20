export const FOUNDATION_BACKUP_KEYS = [
  'notification_qms_level', 'notification_themes_level', 'notification_mentions_level', 'notification_tickets_level',
  'toolbar_button_open_all', 'toolbar_button_pinned', 'toolbar_button_read_all', 'toolbar_simple_list', 'toolbar_default_view',
  'show_all_favorites', 'show_all_qms', 'show_all_mentions', 'open_themes_limit', 'open_in_current_tab', 'open_new_tab_foreground',
  'bw_icons', 'mirror_mode', 'accent_color', 'theme_mode', 'compact_mode', 'show_bookmarks_tab', 'primary_click_action',
  'compact_stats', 'compact_hide_qms', 'compact_hide_favorites', 'compact_hide_mentions', 'compact_only_stats', 'compact_show_topics', 'show_fav_toolbar', 'show_topic_action_buttons',
  'popup_width', 'popup_width_auto', 'max_visible_topics', 'sound_qms', 'sound_themes', 'sound_mentions', 'sound_tickets', 'sound_volume',
  'dnd_enabled', 'dnd_from', 'dnd_to', 'dnd_days', 'dnd_allow_mentions', 'dnd_allow_qms', 'dnd_allow_tickets', 'dnd_mute_radio',
  'tickets_enabled', 'tickets_unlocked', 'radio_enabled', 'radio_volume', 'icon_pack', 'disable_topic_animations',
  'attention_center_enabled', 'attention_center_mode', 'user_profile_mode', 'stable_mode', 'silent_doctor_enabled', 'auto_backup_enabled',
];

const BASE_VALUES = {
  attention_center_enabled: false,
  compact_only_stats: false,
  compact_show_topics: true,
  compact_stats: false,
  dnd_allow_tickets: false,
  popup_width_auto: false,
  show_bookmarks_tab: true,
  show_fav_toolbar: true,
  show_topic_action_buttons: true,
  stable_mode: false,
  toolbar_button_open_all: true,
  toolbar_button_pinned: true,
  toolbar_button_read_all: true,
};

export function getFoundationProfile(profile, ticketsAllowed = false) {
  const profiles = {
    standard: {
      title: 'Обычный пользователь',
      values: {
        ...BASE_VALUES,
        user_profile_mode: 'standard',
        tickets_enabled: false,
        radio_enabled: false,
        primary_click_action: 'forum',
      },
    },
    moderator: {
      title: 'Куратор / Модератор',
      values: {
        ...BASE_VALUES,
        user_profile_mode: 'moderator',
        tickets_enabled: ticketsAllowed,
        radio_enabled: false,
        primary_click_action: 'popup',
        notification_tickets_level: ticketsAllowed ? 20 : 0,
        dnd_allow_tickets: ticketsAllowed,
      },
    },
    minimal: {
      title: 'Минимализм',
      values: {
        ...BASE_VALUES,
        user_profile_mode: 'minimal',
        stable_mode: true,
        compact_stats: true,
        compact_only_stats: true,
        toolbar_default_view: 'collapsed',
        primary_click_action: 'popup',
        show_fav_toolbar: false,
        show_topic_action_buttons: false,
        toolbar_button_open_all: false,
        toolbar_button_pinned: false,
        toolbar_button_read_all: false,
        radio_enabled: false,
        show_bookmarks_tab: false,
        tickets_enabled: false,
      },
    },
    radio: {
      title: 'Радио',
      values: {
        ...BASE_VALUES,
        user_profile_mode: 'radio',
        radio_enabled: true,
      },
    },
  };

  return profiles[profile] || profiles.standard;
}
