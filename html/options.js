// Interval values array - MUST be at the top
// 🚀 NEW: Lower intervals possible thanks to exponential backoff!
const interval_values = [
    10,   // 10 секунд ⚡
    15,   // 15 секунд
    20,   // 20 секунд
    30,   // 30 секунд
    60,   // 1 минута
    120,  // 2 минуты
    300,  // 5 минут
    600,  // 10 минут
    900,  // 15 минут ← защита от Error 429
    1200, // 20 минут
    1800, // 30 минут
    3600  // 1 час
];

// Auto-save delay (milliseconds)
const AUTO_SAVE_DELAY = 500;
let saveTimeout = null;

// Debug mode
const DEBUG = false;

document.addEventListener('DOMContentLoaded', () => {
initializeSidebar();
    loadSettings();
    setupAutoSave();
    setupEasterEgg(); // 🎲 Secret Easter egg!
    setupSoundSettings(); // 🔊 Sound settings
    initFontSettings(); // 🔤 Font settings
    initThemeAndColors(); // 🌙 Theme and colors
    initDnd(); // 🌙 DND settings
    applyFontSettings(); // 🔤 Apply fonts to options page
    initPopupWidthSlider(); // 📐 Popup width slider
});

// Sidebar Navigation
function initializeSidebar() {
    const navItems = document.querySelectorAll('.nav-item');
    const sections = document.querySelectorAll('.content-section');
    
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const sectionId = item.dataset.section;
            
            // Update active nav item
            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');
            
            // Update active section
            sections.forEach(section => section.classList.remove('active'));
            
            const targetSection = document.getElementById(sectionId);
            if (targetSection) {
                targetSection.classList.add('active');
            } else {
                console.error('Section not found:', sectionId);
            }
            
            // Scroll to top of content
            const contentArea = document.querySelector('.content');
            if (contentArea) {
                contentArea.scrollTop = 0;
            }
        });
    });
}

// Load Settings
function loadSettings() {
// 🆕 Default values for new settings (must match cs.js SETTINGS)
    const DEFAULTS = {
        theme_mode: 'liquid-glass',
        accent_color: 'purple',
        sound_qms: false,
        sound_themes: false,
        sound_themes_all_comments: false,
        sound_mentions: false,
        sound_file_qms: 'notify',
        sound_file_themes: 'notify',
        sound_file_mentions: 'notify',
        sound_volume: 50,
        dnd_enabled: false,
        dnd_from: '23:00',
        dnd_to: '08:00',
        dnd_days: [0,1,2,3,4,5,6],
        dnd_allow_mentions: false,
        radio_enabled: false,
        radio_volume: 70,
        primary_click_action: 'forum',
        compact_stats: false,
        max_visible_topics: 0,
        popup_width: 360,
    popup_width_auto: false,
    disable_topic_animations: false,
        show_fav_toolbar: true,
        toolbar_button_open_all:   true,
        toolbar_button_pinned:     true,
        toolbar_button_read_all:   true,
        icon_pack:                 'default',
    };
    
    chrome.storage.local.get()
        .then((items) => {
// 🆕 Apply defaults for missing values
            for (let [key, defaultValue] of Object.entries(DEFAULTS)) {
                if (!(key in items)) {
                    items[key] = defaultValue;
}
            }

            // Блокируем autoSave пока выставляем значения — иначе события change
            // перезапишут только что импортированные настройки текущим состоянием формы
            window._loadingSettings = true;
            
            for (let [key, value] of Object.entries(items)) {
                let el = document.getElementById(key);

                if (!el) {
continue;
                }

                // Handle interval slider specially
                if (key === 'interval') {
setupIntervalSlider(el, value);
                    continue;
                }

                // Handle different input types
                switch (el.tagName) {
                    case 'INPUT':
                        switch (el.type) {
                            case 'checkbox':
                                el.checked = value;
                                break;
                            case 'number':
                                el.value = value;
                                break;
                        }
                        break;
                    case 'FIELDSET':
                        const radio = el.querySelector(`input[value="${value}"]`);
                        if (radio) radio.checked = true;
                        break;
                    default:
                        console.warn(`No inputs for settings ${key}`);
                }
            }
            // Снимаем блокировку после выставления всех значений
            window._loadingSettings = false;
        });
}

// Setup Interval Slider
function setupIntervalSlider(slider, value) {
const output = document.getElementById('interval_output');
    
    if (!output) {
        console.error('interval_output element not found!');
        return;
    }
    
    // Find the index of the saved value
    let idx = interval_values.indexOf(value);
// If saved value doesn't exist in our array, default to 30 seconds
    if (idx === -1) {
        console.warn('Invalid interval value:', value, 'defaulting to 30 seconds');
        value = 30;
        idx = 0;
    }
    
    // Set slider properties
    slider.max = interval_values.length - 1;
    slider.value = idx;
// Update display function
    const updateDisplay = () => {
        // Get the actual value from the array using slider position
        const sliderIndex = parseInt(slider.value);
        const currentValue = interval_values[sliderIndex];
let displayValue = currentValue;
        let displayText = 'сек';
        
        if (currentValue >= 60) {
            displayValue = Math.round(currentValue / 60);
            displayText = 'мин';
        }
        
        output.textContent = `${displayValue} ${displayText}`;
};
    
    // Initial display update
    updateDisplay();
    
    // Listen to input event (fires during drag) - update display only
    slider.addEventListener('input', (e) => {
updateDisplay();
    });
    
    // Listen to change event (fires on release) - update display AND save
    slider.addEventListener('change', (e) => {
updateDisplay();
        scheduleAutoSave();
    });
}

// Setup Auto-save
function setupAutoSave() {
    // Listen to all input changes
    document.querySelectorAll('input').forEach(input => {
        // Skip the interval slider - it has its own handler
        if (input.id === 'interval') {
return;
        }
        
        input.addEventListener('change', () => {
            scheduleAutoSave();
        });
        
        // Also listen to input event for other range sliders (if any)
        if (input.type === 'range' && input.id !== 'interval') {
            input.addEventListener('input', () => {
                scheduleAutoSave();
            });
        }
    });
    
    // Setup stepper buttons for number inputs
    document.querySelectorAll('.stepper-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const targetId = btn.dataset.target;
            const input = document.getElementById(targetId);
            const min = parseInt(input.min);
            const max = parseInt(input.max);
            let value = parseInt(input.value) || min;
            
            if (btn.classList.contains('stepper-increase')) {
                value = Math.min(value + 1, max);
            } else if (btn.classList.contains('stepper-decrease')) {
                value = Math.max(value - 1, min);
            }
            
            input.value = value;
            scheduleAutoSave();
        });
    });
}

// Schedule Auto-save with debounce
function scheduleAutoSave() {
    if (window._loadingSettings) return; // не сохраняем во время первоначальной загрузки
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        saveSettings();
    }, AUTO_SAVE_DELAY);
}

// Save Settings
function saveSettings() {
    let settings = {};
    
    document.querySelectorAll('input').forEach(el => {
        switch (el.type) {
            case 'checkbox':
                settings[el.id] = el.checked;
                break;
            case 'time':
                if (el.id) settings[el.id] = el.value;
                break;
            case 'number':
                // Handle both old number-input and new number-input-stepper
                if (el.classList.contains('number-input-stepper') || el.classList.contains('number-input')) {
                    let value = parseInt(el.value);
                    let min = parseInt(el.min);
                    let max = parseInt(el.max);
                    
                    if (!isNaN(value)) {
                        if (value < min) value = min;
                        else if (value > max) value = max;
                    } else {
                        value = min;
                    }
                    
                    el.value = value;
                    settings[el.id] = value;
                }
                break;
            case 'radio':
                if (el.checked) {
                    // Try to parse as int, if it fails keep as string
                    const parsedValue = parseInt(el.value);
                    settings[el.name] = isNaN(parsedValue) ? el.value : parsedValue;
                }
                break;
            case 'range':
                if (el.id === 'interval') {
                    const intervalValue = interval_values[parseInt(el.value)];
                    settings[el.id] = intervalValue;
                } else if (el.id === 'sound_volume') {
                    // 🔊 Save volume as integer 0-100
                    settings[el.id] = parseInt(el.value);
                } else if (el.id === 'popup_width') {
                    settings[el.id] = parseInt(el.value);
                }
                break;
        }
    });

    // 🔤 font_family — <select id="font-family"> (дефис ≠ подчёркивание)
    const fontFamilyEl = document.getElementById('font-family');
    if (fontFamilyEl && fontFamilyEl.value) {
        settings['font_family'] = fontFamilyEl.value;
    }

    // 🔤 font_size — кнопки .size-btn, не <input>
    const activeSizeBtn = document.querySelector('.size-btn.active');
    if (activeSizeBtn?.dataset.size) {
        settings['font_size'] = activeSizeBtn.dataset.size;
    }

    // 🔤 line_height — <input id="line-height"> (дефис)
    const lineHeightEl = document.getElementById('line-height');
    if (lineHeightEl) {
        settings['line_height'] = lineHeightEl.value;
    }

    // 📅 dnd_days — кнопки .dnd-day-btn.active, не <input>
    const dndGrid = document.getElementById('dnd_days_grid');
    if (dndGrid) {
        settings['dnd_days'] = [...dndGrid.querySelectorAll('.dnd-day-btn.active')]
            .map(b => parseInt(b.dataset.day));
    }

    chrome.storage.local.set(settings, () => {
        showSaveIndicator();
    });
}

// Show Save Indicator
function showSaveIndicator() {
    const indicator = document.getElementById('saveIndicator');
    indicator.classList.add('show');
    
    setTimeout(() => {
        indicator.classList.remove('show');
    }, 2000);
}

// Smooth scroll for sidebar navigation
document.querySelector('.content')?.addEventListener('scroll', () => {
    // Optional: Add scroll-based effects here if needed
});

// 🎲 Easter Egg: Click logo to open random topic from 4PDA
function setupEasterEgg() {
    const logo = document.querySelector('.about-logo');
    if (!logo) return;
    
    logo.addEventListener('click', async () => {
        // Add spinning animation
        logo.classList.add('spinning');
        setTimeout(() => logo.classList.remove('spinning'), 600);
        
        try {
            // Фиксированная ссылка на тему расширения
            const topicUrl = 'https://4pda.to/forum/index.php?showtopic=1117786';
// Respect user's open_in_current_tab setting
            const settings = await chrome.storage.local.get(['open_in_current_tab']);
            const openInCurrentTab = settings.open_in_current_tab || false;
            
            if (openInCurrentTab) {
                // Open in current tab
                window.location.href = topicUrl;
            } else {
                // Open in new tab
                window.open(topicUrl, '_blank');
            }
            
        } catch (error) {
            console.error('🎲 Easter egg failed:', error);
        }
    });
}

// 🔊 Sound Settings
function setupSoundSettings() {
    // Volume slider
    const volumeSlider = document.getElementById('sound_volume');
    const volumeOutput = document.getElementById('sound_volume_output');
    
    if (volumeSlider && volumeOutput) {
        volumeSlider.addEventListener('input', () => {
            volumeOutput.textContent = `${volumeSlider.value}%`;
        });
        volumeSlider.addEventListener('change', () => {
            scheduleAutoSave();
        });
        chrome.storage.local.get(['sound_volume']).then(result => {
            const volume = result.sound_volume !== undefined ? result.sound_volume : 50;
            volumeSlider.value = volume;
            volumeOutput.textContent = `${volume}%`;
        });
    }
    
    // Test sound button — plays all three in sequence
    const testBtn = document.getElementById('sound_test_btn');
    if (testBtn) {
        testBtn.addEventListener('click', () => {
            playTestSound('sound_file_qms');
        });
    }
    
    // 🆕 Preview buttons next to each melody option
    document.querySelectorAll('.sound-preview-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const soundName = btn.dataset.sound;
            const volume = await getSoundVolume();
            await playSound(soundName, volume);
        });
    });
}

// Get current volume from slider
async function getSoundVolume() {
    const result = await chrome.storage.local.get(['sound_volume']);
    return (result.sound_volume !== undefined ? result.sound_volume : 50) / 100;
}

// Play a specific sound file
async function playSound(soundFile, volume) {
    try {
        const audio = new Audio(chrome.runtime.getURL(`sounds/${soundFile}.ogg`));
        audio.volume = Math.max(0, Math.min(1, volume));
        await audio.play();
} catch (error) {
        console.error('🔊 Failed to play sound:', error);
    }
}

// Play test sound for a specific type (by storage key)
async function playTestSound(storageKey) {
    try {
        const settings = await chrome.storage.local.get([storageKey || 'sound_file_themes', 'sound_volume']);
        const soundFile = settings[storageKey] || 'notify';
        const volume = await getSoundVolume();
        await playSound(soundFile, volume);
    } catch (error) {
        console.error('🔊 Failed to play test sound:', error);
    }
}
/* ═══════════════════════════════════════════════════════════
   FONT SETTINGS HANDLERS
   ═══════════════════════════════════════════════════════════ */

// Полная карта шрифтов (15 шрифтов)
const fontFamilies = {
    'system': '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    'inter': '"Inter", -apple-system, sans-serif',
    'roboto': '"Roboto", -apple-system, sans-serif',
    'open-sans': '"Open Sans", -apple-system, sans-serif',
    'pt-sans': '"PT Sans", -apple-system, sans-serif',
    'ubuntu': 'Ubuntu, -apple-system, sans-serif',
    'noto-sans': '"Noto Sans", -apple-system, sans-serif',
    'source-sans': '"Source Sans Pro", -apple-system, sans-serif',
    'verdana': 'Verdana, Geneva, sans-serif',
    'comfortaa': '"Comfortaa", cursive, -apple-system, sans-serif',
    'nunito': '"Nunito", -apple-system, sans-serif',
    'manrope': '"Manrope", -apple-system, sans-serif',
    'rubik': '"Rubik", -apple-system, sans-serif',
    'montserrat': '"Montserrat", -apple-system, sans-serif',
    'jetbrains-mono': '"JetBrains Mono", "Courier New", monospace, -apple-system, sans-serif',
    'bricolage':      '"Bricolage Grotesque", -apple-system, sans-serif',
    'onest':          '"Onest", -apple-system, sans-serif',
    'geologica':      '"Geologica", -apple-system, sans-serif'
};

// Размеры шрифтов
const fontSizes = {
    xs: '12px',
    small: '14px',
    medium: '16px',
    large: '18px',
    xl: '20px',
    xxl: '22px'
};

// Инициализация настроек шрифтов
async function initFontSettings() {
    const fontSelect = document.getElementById('font-family');
    const lineHeightSlider = document.getElementById('line-height');
    const lineHeightValue = document.getElementById('line-height-value');
    const sizeButtons = document.querySelectorAll('.size-btn');
    
    if (!fontSelect || !lineHeightSlider) return;
    
    // Загрузка сохранённых значений
    const data = await chrome.storage.local.get(['font_family', 'font_size', 'line_height']);
    
    // Установка шрифта
    if (data.font_family) {
        fontSelect.value = data.font_family;
        applyFontPreview(data.font_family);
    }
    
    // Установка размера
    if (data.font_size) {
        sizeButtons.forEach(btn => {
            btn.classList.remove('active');
            if (btn.dataset.size === data.font_size) {
                btn.classList.add('active');
            }
        });
    }
    
    // Установка интервала
    if (data.line_height) {
        lineHeightSlider.value = data.line_height;
        lineHeightValue.textContent = data.line_height;
    }
    
    // Обработчик выбора шрифта
    fontSelect.addEventListener('change', async (e) => {
        const fontKey = e.target.value;
        await chrome.storage.local.set({ font_family: fontKey });
        applyFontPreview(fontKey);
        applyFontSettings(); // Применяем ко всей странице
        showSaveIndicator();
});
    
    // Обработчик кнопок размера
    sizeButtons.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const size = e.currentTarget.dataset.size;
            
            sizeButtons.forEach(b => b.classList.remove('active'));
            e.currentTarget.classList.add('active');
            
            await chrome.storage.local.set({ font_size: size });
            applyFontSettings(); // Применяем ко всей странице
            showSaveIndicator();
});
    });
    
    // Обработчик ползунка интервала
    lineHeightSlider.addEventListener('input', async (e) => {
        const value = e.target.value;
        lineHeightValue.textContent = value;
        await chrome.storage.local.set({ line_height: value });
        applyFontSettings(); // Применяем ко всей странице
        showSaveIndicator();
});
}

// Применение шрифта к превью
function applyFontPreview(fontKey) {
    // Dynamically load Google Font for preview if not yet loaded
    const gfUrls = {
        'inter':         'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;700&display=swap',
        'roboto':        'https://fonts.googleapis.com/css2?family=Roboto:wght@300;400;500;700&display=swap',
        'open-sans':     'https://fonts.googleapis.com/css2?family=Open+Sans:wght@300;400;600;700&display=swap',
        'pt-sans':       'https://fonts.googleapis.com/css2?family=PT+Sans:wght@400;700&display=swap',
        'ubuntu':        'https://fonts.googleapis.com/css2?family=Ubuntu:wght@300;400;500;700&display=swap',
        'noto-sans':     'https://fonts.googleapis.com/css2?family=Noto+Sans:wght@300;400;600;700&display=swap',
        'source-sans':   'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@300;400;600;700&display=swap',
        'comfortaa':     'https://fonts.googleapis.com/css2?family=Comfortaa:wght@300;400;700&display=swap',
        'nunito':        'https://fonts.googleapis.com/css2?family=Nunito:wght@300;400;500;700&display=swap',
        'manrope':       'https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;700&display=swap',
        'rubik':         'https://fonts.googleapis.com/css2?family=Rubik:wght@300;400;500;700&display=swap',
        'montserrat':    'https://fonts.googleapis.com/css2?family=Montserrat:wght@300;400;500;700&display=swap',
        'jetbrains-mono':'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&display=swap',
        'bricolage':     'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,300;12..96,400;12..96,500;12..96,700&display=swap',
        'onest':         'https://fonts.googleapis.com/css2?family=Onest:wght@300;400;500;700&display=swap',
        'geologica':     'https://fonts.googleapis.com/css2?family=Geologica:slnt,wght@0,300;0,400;0,500;0,700&display=swap',
    };
    if (gfUrls[fontKey] && !document.getElementById('opt-gfont-' + fontKey)) {
        const lnk = document.createElement('link');
        lnk.rel = 'stylesheet';
        lnk.id = 'opt-gfont-' + fontKey;
        lnk.href = gfUrls[fontKey];
        document.head.appendChild(lnk);
    }
    const fontFamily = fontFamilies[fontKey] || fontFamilies.system;
    const preview = document.querySelector('.font-preview');
    if (preview) {
        preview.style.fontFamily = fontFamily;
    }
}

// Применение шрифтов ко всей странице настроек
async function applyFontSettings() {
    const data = await chrome.storage.local.get(['font_family', 'font_size', 'line_height']);

    if (data.font_family && fontFamilies[data.font_family]) {
        const fontVal = fontFamilies[data.font_family];
        document.body.style.setProperty('font-family', fontVal, 'important');
    }

    // Apply font-size to options page via CSS variables (same as popup)
    if (data.font_size && fontSizes[data.font_size]) {
        const base = parseInt(fontSizes[data.font_size]);
        const root = document.documentElement;
        root.style.setProperty('--font-xs', `${base - 6}px`);
        root.style.setProperty('--font-sm', `${base - 4}px`);
        root.style.setProperty('--font-md', `${base - 3}px`);
        root.style.setProperty('--font-lg', `${base - 2}px`);
        root.style.setProperty('--font-xl', `${base}px`);
        root.style.setProperty('--font-2xl', `${base + 4}px`);
        root.style.setProperty('--font-3xl', `${base + 6}px`);
        document.body.style.fontSize = `${base - 2}px`;
    }

    if (data.line_height) {
        document.body.style.lineHeight = data.line_height;
    }
}

// Вызов при загрузке страницы
document.addEventListener('DOMContentLoaded', () => {
    initFontSettings();
    applyFontSettings(); // Применяем настройки сразу при загрузке
});


/* ═══════════════════════════════════════════════════════════
   DND — НЕ БЕСПОКОИТЬ
   ═══════════════════════════════════════════════════════════ */

async function initDnd() {
    const data = await chrome.storage.local.get([
        'dnd_enabled', 'dnd_from', 'dnd_to', 'dnd_days', 'dnd_allow_mentions'
    ]);

    const enabled       = data.dnd_enabled      ?? false;
    const from          = data.dnd_from          ?? '23:00';
    const to            = data.dnd_to            ?? '08:00';
    const days          = Array.isArray(data.dnd_days) ? data.dnd_days : [0,1,2,3,4,5,6];
    const allowMentions = data.dnd_allow_mentions ?? false;

    // Elements
    const toggleEl    = document.getElementById('dnd_enabled');
    const bodyEl      = document.getElementById('dnd_settings_body');
    const fromEl      = document.getElementById('dnd_from');
    const toEl        = document.getElementById('dnd_to');
    const daysGrid    = document.getElementById('dnd_days_grid');
    const mentionsEl  = document.getElementById('dnd_allow_mentions');
    const hintEl      = document.getElementById('dnd_time_hint');
    const statusEl    = document.getElementById('dnd_status');

    if (!toggleEl || !bodyEl) return;

    // Apply loaded values
    toggleEl.checked   = enabled;
    fromEl.value       = from;
    toEl.value         = to;
    mentionsEl.checked = allowMentions;
    bodyEl.classList.toggle('visible', enabled);

    // Day buttons
    daysGrid.querySelectorAll('.dnd-day-btn').forEach(btn => {
        const d = parseInt(btn.dataset.day);
        if (days.includes(d)) btn.classList.add('active');
    });

    // Helpers
    function parseMins(str) {
        const [h, m] = (str || '00:00').split(':').map(Number);
        return h * 60 + (m || 0);
    }
    function fmtDuration(mins) {
        if (mins <= 0) mins += 1440;
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        if (h === 0) return `${m} мин`;
        if (m === 0) return `${h} ч`;
        return `${h} ч ${m} мин`;
    }
    function updateHint() {
        if (!fromEl.value || !toEl.value) { hintEl.textContent = ''; return; }
        const f = parseMins(fromEl.value);
        const t = parseMins(toEl.value);
        let dur = t - f;
        if (dur <= 0) dur += 1440;
        const crossMidnight = t <= f;
        hintEl.textContent = crossMidnight
            ? `↪ через полночь · ${fmtDuration(dur)}`
            : `${fmtDuration(dur)}`;
    }
    function updateStatus() {
        if (!statusEl) return;
        const isEnabled = toggleEl.checked;
        if (!isEnabled) { statusEl.className = 'dnd-status'; return; }

        const now = new Date();
        const curDay = now.getDay();
        const activeDays = [...daysGrid.querySelectorAll('.dnd-day-btn.active')].map(b => parseInt(b.dataset.day));
        if (!activeDays.includes(curDay)) {
            statusEl.className = 'dnd-status inactive';
            statusEl.textContent = '⏸ Сейчас неактивен — сегодня не выбран в расписании';
            return;
        }
        const f = parseMins(fromEl.value);
        const t = parseMins(toEl.value);
        const nowMin = now.getHours() * 60 + now.getMinutes();
        let active;
        if (f <= t) { active = nowMin >= f && nowMin < t; }
        else        { active = nowMin >= f || nowMin < t; }

        if (active) {
            statusEl.className = 'dnd-status active';
            statusEl.textContent = '🌙 Сейчас активен — уведомления заблокированы';
        } else {
            statusEl.className = 'dnd-status inactive';
            statusEl.textContent = '✅ Сейчас неактивен — уведомления работают';
        }
    }

    function save() {
        const activeDays = [...daysGrid.querySelectorAll('.dnd-day-btn.active')].map(b => parseInt(b.dataset.day));
        chrome.storage.local.set({
            dnd_enabled:       toggleEl.checked,
            dnd_from:          fromEl.value,
            dnd_to:            toEl.value,
            dnd_days:          activeDays,
            dnd_allow_mentions: mentionsEl.checked,
        }, () => showSaveIndicator());
        updateStatus();
    }

    // Events
    toggleEl.addEventListener('change', () => {
        bodyEl.classList.toggle('visible', toggleEl.checked);
        save();
    });
    fromEl.addEventListener('change', () => { updateHint(); save(); });
    toEl.addEventListener('change',   () => { updateHint(); save(); });
    mentionsEl.addEventListener('change', save);

    daysGrid.querySelectorAll('.dnd-day-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            save();
        });
    });

    // Init display
    updateHint();
    updateStatus();
    setInterval(updateStatus, 60000); // Обновляем статус каждую минуту
}

/* ═══════════════════════════════════════════════════════════
   THEME AND ACCENT COLOR HANDLERS
   ═══════════════════════════════════════════════════════════ */

// Инициализация темы и цветов
async function initThemeAndColors() {
    const data = await chrome.storage.local.get(['theme_mode', 'accent_color']);
    
    // Применяем тему
    const theme = data.theme_mode || 'liquid-glass';
    applyTheme(theme);
    
    // Устанавливаем выбранную тему
    const themeInputs = document.querySelectorAll('input[name="theme_mode"]');
    themeInputs.forEach(input => {
        if (input.value === theme) {
            input.checked = true;
        }
    });
    
    // Обработчик выбора темы
    themeInputs.forEach(input => {
        input.addEventListener('change', async (e) => {
            const selectedTheme = e.target.value;
            await chrome.storage.local.set({ theme_mode: selectedTheme });
            applyTheme(selectedTheme);
            showSaveIndicator();
});
    });
    
    // Применяем цвет акцента (миграция: green → teal, pink/red → blue)
    let accent = data.accent_color || 'purple';
    if (accent === 'green') accent = 'teal';
    if (accent === 'pink' || accent === 'red') accent = 'blue';
    document.body.setAttribute('data-accent', accent);
    
    // Устанавливаем выбранный цвет
    const colorInputs = document.querySelectorAll('input[name="accent_color"]');
    colorInputs.forEach(input => {
        if (input.value === accent) {
            input.checked = true;
        }
    });
    
    // Обработчик выбора цвета
    colorInputs.forEach(input => {
        input.addEventListener('change', async (e) => {
            const selectedColor = e.target.value;
            await chrome.storage.local.set({ accent_color: selectedColor });
            document.body.setAttribute('data-accent', selectedColor);
            showSaveIndicator();
});
    });
}

// Применение темы
function applyTheme(theme) {
    if (theme === 'auto') {
        // Определяем системную тему
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        document.body.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
        
        // Слушаем изменения системной темы
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            chrome.storage.local.get(['theme_mode'], (data) => {
                if (data.theme_mode === 'auto') {
                    document.body.setAttribute('data-theme', e.matches ? 'dark' : 'light');
                }
            });
        });
    } else {
        document.body.setAttribute('data-theme', theme);
    }
    // Re-init glass dropdowns immediately when theme changes
    setTimeout(initGlassDropdowns, 0);
}




/* ═══════════════════════════════════════════════════════════
   LIQUID GLASS CUSTOM DROPDOWN
   Заменяет нативный <select> красивым glass-дропдауном
   ═══════════════════════════════════════════════════════════ */

function buildGlassDropdown(selectEl) {
    if (!selectEl || selectEl.dataset.glassified) return;
    // Don't wrap if already inside a glass-wrapper
    if (selectEl.parentNode?.classList.contains('glass-dropdown-wrapper')) return;
    selectEl.dataset.glassified = '1';

    // Wrap in container
    const wrapper = document.createElement('div');
    wrapper.className = 'glass-dropdown-wrapper';
    selectEl.parentNode.insertBefore(wrapper, selectEl);
    wrapper.appendChild(selectEl);

    // Hard-hide native select IMMEDIATELY
    selectEl.style.cssText = 'display:none!important;position:absolute;opacity:0;pointer-events:none;';

    // Trigger button
    const trigger = document.createElement('div');
    trigger.className = 'glass-dropdown-trigger';
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-expanded', 'false');

    const triggerText = document.createElement('span');
    triggerText.className = 'glass-dropdown-value';
    const selectedOpt = selectEl.options[selectEl.selectedIndex];
    triggerText.textContent = selectedOpt ? selectedOpt.text : '';

    const triggerArrow = document.createElement('span');
    triggerArrow.className = 'glass-dropdown-arrow';
    triggerArrow.innerHTML = `<svg width="12" height="8" viewBox="0 0 12 8" fill="none">
        <path d="M1 1l5 5 5-5" stroke="rgba(255,255,255,0.7)" stroke-width="2" stroke-linecap="round"/>
    </svg>`;

    trigger.appendChild(triggerText);
    trigger.appendChild(triggerArrow);
    wrapper.appendChild(trigger);

    // List of options
    const listbox = document.createElement('div');
    listbox.className = 'glass-dropdown-list';
    listbox.setAttribute('role', 'listbox');

    Array.from(selectEl.options).forEach((opt) => {
        const item = document.createElement('div');
        item.className = 'glass-dropdown-item';
        if (opt.selected) item.classList.add('selected');
        item.setAttribute('role', 'option');
        item.setAttribute('data-value', opt.value);
        item.textContent = opt.text;

        item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            selectEl.value = opt.value;
            triggerText.textContent = opt.text;
            listbox.querySelectorAll('.glass-dropdown-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            closeList();
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
        });

        listbox.appendChild(item);
    });

    wrapper.appendChild(listbox);

    let isOpen = false;

    function openList() {
        isOpen = true;
        const rect=trigger.getBoundingClientRect(),spaceBelow=window.innerHeight-rect.bottom,spaceAbove=rect.top,maxH=280;
        if (spaceBelow<maxH&&spaceAbove>spaceBelow) {
            listbox.style.top='auto';listbox.style.bottom='100%';listbox.style.borderRadius='12px 12px 0 0';listbox.style.maxHeight=Math.min(maxH,spaceAbove-8)+'px';
        } else {
            listbox.style.top='100%';listbox.style.bottom='auto';listbox.style.borderRadius='0 0 12px 12px';listbox.style.maxHeight=Math.min(maxH,spaceBelow-8)+'px';
        }
        listbox.classList.add('open');trigger.setAttribute('aria-expanded','true');trigger.classList.add('open');
        const sel=listbox.querySelector('.selected');if(sel)sel.scrollIntoView({block:'nearest'});
    }

    function closeList() {
        isOpen = false;
        listbox.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.classList.remove('open');
    }

    trigger.addEventListener('click', () => {
        isOpen ? closeList() : openList();
    });

    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); isOpen ? closeList() : openList(); }
        if (e.key === 'Escape') closeList();
    });

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) closeList();
    });

    // Sync when value changed externally
    selectEl.addEventListener('_glassUpdate', () => {
        const opt = selectEl.options[selectEl.selectedIndex];
        if (opt) {
            triggerText.textContent = opt.text;
            listbox.querySelectorAll('.glass-dropdown-item').forEach(el => {
                el.classList.toggle('selected', el.dataset.value === selectEl.value);
            });
        }
    });
}

function destroyGlassDropdowns() {
    document.querySelectorAll('.glass-dropdown-wrapper').forEach(w => {
        const sel = w.querySelector('select');
        if (sel) {
            // Restore native select visibility
            sel.style.cssText = '';
            delete sel.dataset.glassified;
            w.parentNode.insertBefore(sel, w);
        }
        w.remove();
    });
}

function initGlassDropdowns() {
    // Always destroy first to handle theme switching cleanly
    destroyGlassDropdowns();
    // Build custom dropdown for ALL themes (CSS handles per-theme styling)
    document.querySelectorAll('select.setting-select, select').forEach(sel => buildGlassDropdown(sel));
}
document.addEventListener('DOMContentLoaded',()=>setTimeout(initGlassDropdowns,100));
const _themeObserver=new MutationObserver(()=>setTimeout(initGlassDropdowns,50));
_themeObserver.observe(document.body,{attributes:true,attributeFilter:['data-theme']});

// ══════════════════════════════════════════════════════
// 🎵 RADIO — Options page control
// ══════════════════════════════════════════════════════
const BUILT_IN_STATIONS = {
    '🇷🇺 Европа Плюс':          'https://ep256.hostingradio.ru:8052/europaplus256.mp3',
    '🇷🇺 Русское Радио':        'https://rusradio.hostingradio.ru/rusradio128.mp3',
    '🇷🇺 Радио Рекорд':         'https://radiorecord.hostingradio.ru/rr_main96.aacp',
    '🇷🇺 Ретро FM':             'https://retro.hostingradio.ru:8014/retro320.mp3',
    '🇷🇺 Радио Шансон':         'https://chanson.hostingradio.ru:8041/chanson256.mp3',
    '🇷🇺 DFM':                  'https://dfm.hostingradio.ru/dfm96.aacp',
    '🇷🇺 DFM Russian Dance':    'https://dfm-dfmrusdance.hostingradio.ru/dfmrusdance96.aacp',
    '🇷🇺 Дорожное Радио':       'https://dorognoe.hostingradio.ru:8000/dorognoe',
    '🇷🇺 Маяк':                 'https://icecast-vgtrk.cdnvideo.ru/mayakfm_aac_64kbps',
    '🇷🇺 Вести FM':             'https://icecast-vgtrk.cdnvideo.ru/vestifm_aac_64kbps',
    '🇷🇺 Радио России':         'https://icecast-vgtrk.cdnvideo.ru/rrzonam_mp3_192kbps',
    '🇷🇺 Наше Радио':           'https://nashe1.hostingradio.ru/nashe-128.mp3',
    '🇷🇺 Maximum':              'https://maximum.hostingradio.ru/maximum96.aacp',
    '🇩🇪 Радио Картина':        'https://rs.kartina.tv/kartina_320kb',
    '🇰🇿 LuxFM':                'https://icecast.luxfm.kz/luxfm',
    '🇰🇿 Radio NS':             'https://icecast.ns.kz/radions',
    '🇰🇿 NRJ Kazakhstan':       'https://nrj-nrjkaz.hostingradio.ru/nrjkaz96.aacp',
    '🇺🇦 Хіт FM':               'https://online.hitfm.ua/HitFM',
    '🇺🇦 Kiss FM UA':           'https://online.kissfm.ua/KissFM',
    '🇺🇦 Radio ROKS':           'https://online.radioroks.ua/RadioROKS',
};

function countryCodeToFlag(cc) {
    if (!cc || cc.length !== 2) return '🌐';
    return String.fromCodePoint(...cc.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

async function getCustomStations() {
    const r = await chrome.storage.local.get(['radio_custom_stations']);
    return r.radio_custom_stations || {};
}
async function saveCustomStations(obj) {
    await chrome.storage.local.set({ radio_custom_stations: obj });
}

async function getAllStations() {
    const custom = await getCustomStations();
    return { ...BUILT_IN_STATIONS, ...custom };
}

async function fillStationSelect() {
    const sel = document.getElementById('radio_station_select');
    if (!sel) return;
    const all = await getAllStations();
    const r = await chrome.storage.local.get(['radio_station']);
    const current = r.radio_station || '';
    sel.innerHTML = '<option value="">— Выберите станцию —</option>';
    for (const [name, url] of Object.entries(all)) {
        const opt = document.createElement('option');
        opt.value = url; opt.textContent = name;
        if (url === current) opt.selected = true;
        sel.appendChild(opt);
    }
}

async function setupRadioUI() {
    const enabledCb = document.getElementById('radio_enabled');
    const playerSection = document.getElementById('radio_player_section');
    if (!enabledCb || !playerSection) return;

    const r = await chrome.storage.local.get(['radio_enabled','radio_volume','radio_station','radio_playing','radio_station_name']);
    enabledCb.checked = !!r.radio_enabled;
    playerSection.style.display = r.radio_enabled ? '' : 'none';

    // Volume
    const volSlider = document.getElementById('radio_volume_slider');
    const volLabel  = document.getElementById('radio_volume_label');
    if (volSlider) {
        volSlider.value = r.radio_volume !== undefined ? r.radio_volume : 70;
        if (volLabel) volLabel.textContent = volSlider.value + '%';
        volSlider.addEventListener('input', () => {
            if (volLabel) volLabel.textContent = volSlider.value + '%';
        });
        volSlider.addEventListener('change', () => {
            chrome.runtime.sendMessage({ action: 'radio_set_volume', volume: parseInt(volSlider.value) });
            scheduleAutoSave();
        });
    }

    // Station select
    await fillStationSelect();
    const sel = document.getElementById('radio_station_select');
    if (sel) {
        sel.addEventListener('change', () => {
            const name = sel.options[sel.selectedIndex]?.textContent || '';
            chrome.runtime.sendMessage({ action: 'radio_play', station: sel.value, stationName: name });
            updateRadioPlayBtn(true);
        });
    }

    // Play/Pause button
    updateRadioPlayBtn(!!r.radio_playing);
    document.getElementById('radio_play_btn')?.addEventListener('click', async () => {
        const state = await chrome.runtime.sendMessage({ action: 'radio_get_state' });
        if (state?.isPlaying) {
            chrome.runtime.sendMessage({ action: 'radio_pause' });
            updateRadioPlayBtn(false);
        } else {
            const stUrl = document.getElementById('radio_station_select')?.value || r.radio_station;
            const stName = document.getElementById('radio_station_select')?.options[document.getElementById('radio_station_select').selectedIndex]?.textContent || r.radio_station_name;
            if (stUrl) {
                chrome.runtime.sendMessage({ action: 'radio_play', station: stUrl, stationName: stName });
                updateRadioPlayBtn(true);
            }
        }
    });

    // Enable toggle
    enabledCb.addEventListener('change', () => {
        playerSection.style.display = enabledCb.checked ? '' : 'none';
        chrome.runtime.sendMessage({ action: 'radio_set_enabled', enabled: enabledCb.checked });
    });

    // Station name display
    const nameEl = document.getElementById('radio_current_station_name');
    if (nameEl && r.radio_station_name) nameEl.textContent = r.radio_station_name;

    // Search
    document.getElementById('radio_search_btn')?.addEventListener('click', doRadioSearch);
    document.getElementById('radio_search_input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doRadioSearch(); });

    // Custom station add
    document.getElementById('radio_custom_add_btn')?.addEventListener('click', async () => {
        const name = document.getElementById('radio_custom_name')?.value.trim();
        const url  = document.getElementById('radio_custom_url')?.value.trim();
        if (!name || !url) return;
        const custom = await getCustomStations();
        custom[name] = url;
        await saveCustomStations(custom);
        await fillStationSelect();
        document.getElementById('radio_custom_name').value = '';
        document.getElementById('radio_custom_url').value = '';
    });

    // Delete custom stations
    document.getElementById('radio_delete_custom_btn')?.addEventListener('click', async () => {
        if (confirm('Удалить все пользовательские станции?')) {
            await saveCustomStations({});
            await fillStationSelect();
        }
    });

    // Listen for radio state updates from background
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.action === 'radio_state') {
            updateRadioPlayBtn(msg.state?.isPlaying);
            const nameEl2 = document.getElementById('radio_current_station_name');
            if (nameEl2 && msg.state?.stationName) nameEl2.textContent = msg.state.stationName;
        }
    });
}

function updateRadioPlayBtn(isPlaying) {
    const btn = document.getElementById('radio_play_btn');
    if (!btn) return;
    const icon = document.getElementById('radio_play_icon');
    if (icon) icon.textContent = isPlaying ? '⏸' : '▶';
    btn.title = isPlaying ? 'Пауза' : 'Играть';
}

async function doRadioSearch() {
    const q = document.getElementById('radio_search_input')?.value.trim();
    if (!q) return;
    const resultsEl = document.getElementById('radio_search_results');
    if (!resultsEl) return;
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = '<div style="padding:8px; color:var(--text-secondary); font-size:13px;">Поиск...</div>';
    try {
        const resp = await fetch(`https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(q)}&limit=10`);
        const data = await resp.json();
        resultsEl.innerHTML = '';
        if (!data.length) {
            resultsEl.innerHTML = '<div style="padding:8px; color:var(--text-secondary); font-size:13px;">Ничего не найдено</div>';
            return;
        }
        for (const st of data) {
            const flag = countryCodeToFlag(st.countrycode);
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 10px; border-bottom:1px solid var(--border); font-size:13px;';
            row.innerHTML = `<span>${flag} ${st.name}</span>`;
            const addBtn = document.createElement('button');
            addBtn.textContent = '+';
            addBtn.className = 'interactive';
            addBtn.style.cssText = 'padding:3px 10px; border-radius:6px; background:var(--accent); color:#fff; border:none; cursor:pointer; font-size:12px;';
            addBtn.addEventListener('click', async () => {
                const sName = `${flag} ${st.name}`;
                const custom = await getCustomStations();
                custom[sName] = st.url_resolved;
                await saveCustomStations(custom);
                await fillStationSelect();
                addBtn.textContent = '✓';
                addBtn.disabled = true;
            });
            row.appendChild(addBtn);
            resultsEl.appendChild(row);
        }
    } catch(e) {
        resultsEl.innerHTML = '<div style="padding:8px; color:var(--text-secondary); font-size:13px;">Ошибка поиска</div>';
    }
}

// Initialize radio UI when DOM ready
document.addEventListener('DOMContentLoaded', () => setupRadioUI());


// ══════════════════════════════════════════════════════
const TRANSLATIONS = {
    ru: {
        nav_fourpulse: '4Pulse',
        sec_fourpulse: '4Pulse',
        sec_fourpulse_desc: 'Эксклюзивные возможности расширения 4Pulse',
        card_radio: 'Радио',
        card_radio_desc: 'Слушай радио прямо в расширении — не прерывается при смене вкладок',
        radio_enable: 'Включить радиоплеер',
        radio_enable_desc: 'Показывает мини-плеер в попапе и сайдбаре',
        radio_no_station: 'Станция не выбрана',
        radio_station_lbl: 'Радиостанция',
        radio_select_station: '— Выберите станцию —',
        radio_search_btn: 'Найти',
        radio_custom_add: '+ Добавить свою станцию',
        radio_custom_add_btn: 'Добавить',
        radio_delete_custom: '🗑 Удалить пользовательские станции',
        radio_mini_radio: '🎵 Радио',
        header_subtitle: 'Персональная настройка',
        nav_notifications: 'Уведомления',
        nav_sync: 'Синхронизация',
        nav_appearance: 'Внешний вид',
        nav_about: 'О расширении',
        sec_notifications: 'Уведомления',
        sec_notifications_desc: 'Настройте всплывающие уведомления для разных типов событий',
        sec_sync: 'Синхронизация',
        sec_sync_desc: 'Частота проверки новых событий и сообщений',
        sec_appearance: 'Внешний вид',
        sec_appearance_desc: 'Тема, шрифт, цвет и расположение элементов',
        sec_about: 'О расширении',
        sec_about_desc: 'Версия, ссылки и благодарности',
        card_language: '🌐 Язык интерфейса',
        card_language_desc: 'Выберите язык для всех надписей расширения',
        tdesc_sound_qms:'Звук при новых личных сообщениях',
        tdesc_sound_topics:'Звук при новых сообщениях в избранных темах',
        tdesc_sound_repeat:'Играть звук повторно, если в непрочитанную тему пришёл ещё один комментарий',
        tdesc_sound_mentions:'Звук при новых упоминаниях',
        tdesc_show_topics:'Включая прочитанные темы из избранного',
        tdesc_show_qms:'Включая прочитанные диалоги',
        tdesc_show_mentions:'Включая прочитанные упоминания',
        tdesc_hide_popup:'Автоматически закрывать попап расширения по клику и открывать новую вкладку',
        tdesc_current_tab:'Темы, QMS и упоминания будут открываться в текущей вкладке вместо новых вкладок',
        tdesc_compact:'Компактное отображение без деталей',
        tdesc_bw_icons:'Убрать цвет с эмодзи-иконок для минималистичного вида',
        hint_interval:'Рекомендуется: 30 сек или больше. Частые запросы могут привести к временной блокировке (error 429).',
        hint_batch:'Ограничение количества одновременно открываемых вкладок',
        // Cards & labels
        card_dnd:'🌙 Не беспокоить', card_dnd_desc:'Блокирует уведомления и звуки в указанное время',
        dnd_enable:'Включить режим «Не беспокоить»', dnd_enable_desc:'Уведомления не будут показываться в выбранное время',
        dnd_from:'С', dnd_to:'До', dnd_days:'Дни',
        day_mon:'Пн', day_tue:'Вт', day_wed:'Ср', day_thu:'Чт', day_fri:'Пт', day_sat:'Сб', day_sun:'Вс',
        dnd_mentions:'Упоминания пробивают DND', dnd_mentions_desc:'@ Уведомления об упоминаниях будут приходить даже в тихие часы',
        card_qms:'Сообщения (QMS)', card_qms_desc:'Личные сообщения на форуме',
        qms_all:'Все сообщения', qms_all_desc:'Уведомления о каждом новом сообщении',
        qms_new:'Новые диалоги', qms_new_desc:'Только при начале нового диалога',
        notify_off:'Не оповещать', notify_off_desc:'Отключить уведомления',
        card_sound:'🔊 Звук уведомлений', card_sound_desc:'Звуковое оповещение при новых событиях',
        sound_qms_lbl:'📧 QMS (личные сообщения)', sound_topics_lbl:'Темы',
        sound_all_comments:'Звук на каждый новый комментарий', sound_mentions_lbl:'Упоминания',
        sound_melody_qms:'🔔 Мелодия для QMS', sound_melody_topics:'⭐ Мелодия для тем', sound_melody_mentions:'@ Мелодия для упоминаний',
        sound_volume_lbl:'Громкость', sound_test:'🔊 Проверить звук',
        snd_notify_desc:'Мягкий звук уведомления', snd_excl_desc:'Короткий, привлекающий внимание',
        snd_fg_desc:'Приятный мелодичный звук', snd_bubble_desc:'Мягкий лопающийся пузырь',
        snd_ping_desc:'Чёткий короткий пинг', snd_chime_desc:'Нежный перезвон колокольчиков',
        snd_dong_desc:'Двойной классический тон', snd_whoosh_desc:'Энергичный нарастающий свист',
        card_topics_notify:'Темы форума', card_topics_notify_desc:'Избранные темы и обсуждения',
        topics_notify_lbl:'Всплывающие уведомления',
        topics_all_comments:'Все комментарии', topics_new_pinned:'Новые темы + комментарии в закреплённых',
        topics_new_all:'Все новые темы', topics_new_pinned_only:'Новые закреплённые темы',
        card_mentions_notify:'Упоминания', card_mentions_notify_desc:'Когда кто-то упоминает ваш ник',
        mentions_all:'Все упоминания', mentions_all_desc:'Уведомления о каждом упоминании',
        card_frequency:'Частота обновления', card_frequency_desc:'Более частые обновления увеличивают нагрузку на сервер',
        card_pinned:'Закреплённые темы', card_pinned_desc:'Как отображать закреплённые темы',
        pinned_all:'Все темы вместе', pinned_all_desc:'Закреплённые и обычные темы в общем списке',
        pinned_top:'Закреплённые сверху', pinned_top_desc:'Закреплённые темы показываются первыми',
        pinned_only:'Только закреплённые', pinned_only_desc:'Показывать только закреплённые темы',
        card_popup_view:'Вид попапа при открытии', card_popup_view_desc:'Что показывать при открытии расширения',
        popup_view_collapsed:'Свернуто (только статистика)', popup_view_collapsed_desc:'Показать только счётчики, без списков',
        popup_view_qms:'Открыть вкладку "QMS"', popup_view_qms_desc:'Автоматически показать QMS диалоги',
        popup_view_topics:'Открыть вкладку "Темы"', popup_view_topics_desc:'Автоматически показать список тем',
        popup_view_mentions:'Открыть вкладку "Упоминания"', popup_view_mentions_desc:'Автоматически показать упоминания',
        card_elements:'Отображение элементов', card_elements_desc:'Показывать все элементы или только непрочитанные',
        card_interface_opt:'Опциональность интерфейса', card_interface_opt_desc:'Скрыть ненужные элементы интерфейса', show_bookmarks_tab:'🔖 Показывать вкладку «Закладки»', tdesc_bookmarks_tab:'Плитка «Закладки» в статистике и вкладка в попапе/сайдбаре', show_all_topics:'Показывать все темы', show_all_qms:'Показывать все QMS диалоги', show_all_mentions:'Показывать все упоминания',
        card_buttons:'Управляющие кнопки', card_buttons_desc:'Кнопки массовых действий в попапе',
        btn_open_unread:'"Открыть непрочитанные темы"', btn_open_unread_desc:'Показать кнопку массового открытия тем',
        btn_batch_size:'Открывать порциями по', btn_batch_unit:'тем',
        btn_pinned_lbl:'"Закреплённые темы"', btn_pinned_desc:'Показать кнопку открытия закреплённых тем',
        btn_read_all_lbl:'"Пометить все темы прочитанными"', btn_read_all_desc:'Показать кнопку массовой пометки тем',
        card_open_topics:'Открытие тем', card_open_topics_desc:'Как открывать темы при клике',
        open_hide_popup:'Скрывать попап после открытия темы',
        open_current_tab:'Открывать ссылки в текущей вкладке', open_compact:'Упрощённый вид списка тем',
        card_icons:'Иконки', card_icons_desc:'Настройки отображения эмодзи-иконок', icons_bw:'Чёрно-белые иконки',
        card_accent:'Цвет акцента', card_accent_desc:'Цвет подсветки активных элементов',
        accent_blue:'🔵 Синий (4PDA)', accent_blue_desc:'Цвет в стиле форума 4PDA',
        accent_teal:'🩵 Teal (бирюзовый)', accent_teal_desc:'Свежий бирюзово-зелёный цвет',
        accent_purple:'🟣 Фиолетовый', accent_purple_desc:'Элегантный и современный',
        accent_orange:'🟠 Оранжевый', accent_orange_desc:'Тёплый и позитивный',
        card_theme:'Цветовая схема', card_theme_desc:'Выберите светлую или тёмную тему',
        theme_light:'☀️ Светлая', theme_light_desc:'Классический светлый интерфейс',
        theme_dark:'🌙 Тёмная', theme_dark_desc:'Для комфорта глаз в темноте',
        theme_auto:'🌓 Авто', theme_auto_desc:'Следовать за системной темой',
        theme_glass:'✨ Liquid Glass', theme_glass_desc:'Стеклянный эффект с размытием и переливами — максимально стильно', theme_cosmic:'🌌 Cosmic Pulse', theme_cosmic_desc:'Космический неоновый стиль — глубокий тёмный фон с циановым свечением',
        card_font:'Шрифт интерфейса', card_font_desc:'Выберите шрифт с хорошей читаемостью кириллицы',
        card_size:'Размер и интервалы', card_size_desc:'Настройте комфортный размер текста',
        size_font_lbl:'Размер шрифта', size_spacing_lbl:'Межстрочный интервал',
        size_narrow:'Узкий', size_normal:'Обычный', size_wide:'Широкий',
        popup_stats: 'Статистика', popup_topics: 'Темы', popup_mentions: 'Ответы',
        popup_open_all: 'Открыть все', popup_pinned: 'Закреплённые', popup_read_all: 'Прочитать все',
        popup_empty: 'Непрочитанных тем нет', popup_last_update: 'Последнее обновление:',
    },
    en: {
        nav_fourpulse: '4Pulse',
        sec_fourpulse: '4Pulse',
        sec_fourpulse_desc: 'Exclusive features of the 4Pulse extension',
        card_radio: 'Radio',
        card_radio_desc: 'Listen to radio inside the extension — keeps playing when switching tabs',
        radio_enable: 'Enable radio player',
        radio_enable_desc: 'Shows a mini-player in popup and sidebar',
        radio_no_station: 'No station selected',
        radio_station_lbl: 'Station',
        radio_select_station: '— Select station —',
        radio_search_btn: 'Search',
        radio_custom_add: '+ Add custom station',
        radio_custom_add_btn: 'Add',
        radio_delete_custom: '🗑 Delete custom stations',
        radio_mini_radio: '🎵 Radio',
        header_subtitle: 'Personal settings',
        nav_notifications: 'Notifications',
        nav_sync: 'Sync',
        nav_appearance: 'Appearance',
        nav_about: 'About',
        sec_notifications: 'Notifications',
        sec_notifications_desc: 'Configure alerts for different event types',
        sec_sync: 'Sync',
        sec_sync_desc: 'How often to check for new events and messages',
        sec_appearance: 'Appearance',
        sec_appearance_desc: 'Theme, font, color and layout settings',
        sec_about: 'About',
        sec_about_desc: 'Version, links and credits',
        card_language: '🌐 Interface language',
        card_language_desc: 'Choose the language for all extension labels',
        tdesc_sound_qms:'Sound for new private messages',
        tdesc_sound_topics:'Sound for new messages in favorite topics',
        tdesc_sound_repeat:'Play sound again when another comment arrives in an unread topic',
        tdesc_sound_mentions:'Sound for new mentions',
        tdesc_show_topics:'Including read topics from favorites',
        tdesc_show_qms:'Including read conversations',
        tdesc_show_mentions:'Including read mentions',
        tdesc_hide_popup:'Automatically close the popup on click and open a new tab',
        tdesc_current_tab:'Topics, QMS and mentions will open in the current tab instead of new tabs',
        tdesc_compact:'Compact display without details',
        tdesc_bw_icons:'Remove color from emoji icons for a minimalist look',
        hint_interval:'Recommended: 30 sec or more. Frequent requests may cause a temporary block (error 429).',
        hint_batch:'Limit on the number of tabs opened simultaneously',
        card_dnd:'🌙 Do Not Disturb', card_dnd_desc:'Blocks notifications and sounds during set hours',
        dnd_enable:'Enable Do Not Disturb', dnd_enable_desc:'Notifications will not appear during selected hours',
        dnd_from:'From', dnd_to:'To', dnd_days:'Days',
        day_mon:'Mo', day_tue:'Tu', day_wed:'We', day_thu:'Th', day_fri:'Fr', day_sat:'Sa', day_sun:'Su',
        dnd_mentions:'Mentions break DND', dnd_mentions_desc:'@ Mention notifications will arrive even during quiet hours',
        card_qms:'Messages (QMS)', card_qms_desc:'Private messages on the forum',
        qms_all:'All messages', qms_all_desc:'Notify on every new message',
        qms_new:'New conversations', qms_new_desc:'Only when a new conversation starts',
        notify_off:'No notifications', notify_off_desc:'Disable notifications',
        card_sound:'🔊 Notification sounds', card_sound_desc:'Sound alerts for new events',
        sound_qms_lbl:'📧 QMS (private messages)', sound_topics_lbl:'Topics',
        sound_all_comments:'Sound for every new comment', sound_mentions_lbl:'Mentions',
        sound_melody_qms:'🔔 Melody for QMS', sound_melody_topics:'⭐ Melody for topics', sound_melody_mentions:'@ Melody for mentions',
        sound_volume_lbl:'Volume', sound_test:'🔊 Test sound',
        snd_notify_desc:'Soft notification sound', snd_excl_desc:'Short, attention-grabbing',
        snd_fg_desc:'Pleasant melodic sound', snd_bubble_desc:'Soft popping bubble',
        snd_ping_desc:'Clear short ping', snd_chime_desc:'Gentle bell chime',
        snd_dong_desc:'Classic double tone', snd_whoosh_desc:'Energetic rising whoosh',
        card_topics_notify:'Forum topics', card_topics_notify_desc:'Favorite topics and discussions',
        topics_notify_lbl:'Desktop notifications',
        topics_all_comments:'All comments', topics_new_pinned:'New topics + comments in pinned',
        topics_new_all:'All new topics', topics_new_pinned_only:'New pinned topics only',
        card_mentions_notify:'Mentions', card_mentions_notify_desc:'When someone mentions your username',
        mentions_all:'All mentions', mentions_all_desc:'Notify on every mention',
        card_frequency:'Update frequency', card_frequency_desc:'More frequent updates increase server load',
        card_pinned:'Pinned topics', card_pinned_desc:'How to display pinned topics',
        pinned_all:'All topics together', pinned_all_desc:'Pinned and regular topics in one list',
        pinned_top:'Pinned at top', pinned_top_desc:'Pinned topics appear first',
        pinned_only:'Pinned only', pinned_only_desc:'Show only pinned topics',
        card_popup_view:'Popup view on open', card_popup_view_desc:'What to show when the extension opens',
        popup_view_collapsed:'Collapsed (stats only)', popup_view_collapsed_desc:'Show counters only, no lists',
        popup_view_qms:'Open "QMS" tab', popup_view_qms_desc:'Automatically show QMS conversations',
        popup_view_topics:'Open "Topics" tab', popup_view_topics_desc:'Automatically show topic list',
        popup_view_mentions:'Open "Mentions" tab', popup_view_mentions_desc:'Automatically show mentions',
        card_elements:'Element display', card_elements_desc:'Show all items or unread only',
        card_interface_opt:'Interface options', card_interface_opt_desc:'Hide unnecessary interface elements', show_bookmarks_tab:'🔖 Show Bookmarks tab', tdesc_bookmarks_tab:'Bookmarks tile in stats and tab in popup/sidebar', show_all_topics:'Show all topics', show_all_qms:'Show all QMS conversations', show_all_mentions:'Show all mentions',
        card_buttons:'Action buttons', card_buttons_desc:'Bulk action buttons in popup',
        btn_open_unread:'"Open unread topics"', btn_open_unread_desc:'Show bulk open button',
        btn_batch_size:'Open in batches of', btn_batch_unit:'topics',
        btn_pinned_lbl:'"Pinned topics"', btn_pinned_desc:'Show the pinned topics button',
        btn_read_all_lbl:'"Mark all topics as read"', btn_read_all_desc:'Show bulk read button',
        card_open_topics:'Open topics', card_open_topics_desc:'How to open topics on click',
        open_hide_popup:'Hide popup after opening topic',
        open_current_tab:'Open links in current tab', open_compact:'Compact topic list view',
        card_icons:'Icons', card_icons_desc:'Emoji icon display settings', icons_bw:'Black & white icons',
        card_accent:'Accent color', card_accent_desc:'Highlight color for active elements',
        accent_blue:'🔵 Blue (4PDA)', accent_blue_desc:'4PDA forum style color',
        accent_teal:'🩵 Teal', accent_teal_desc:'Fresh teal-green color',
        accent_purple:'🟣 Purple', accent_purple_desc:'Elegant and modern',
        accent_orange:'🟠 Orange', accent_orange_desc:'Warm and positive',
        card_theme:'Color scheme', card_theme_desc:'Choose light or dark theme',
        theme_light:'☀️ Light', theme_light_desc:'Classic light interface',
        theme_dark:'🌙 Dark', theme_dark_desc:'Easy on the eyes in low light',
        theme_auto:'🌓 Auto', theme_auto_desc:'Follow system theme',
        theme_glass:'✨ Liquid Glass', theme_glass_desc:'Glass effect with blur and shimmer — maximum style', theme_cosmic:'🌌 Cosmic Pulse', theme_cosmic_desc:'Cosmic neon style — deep dark background with cyan glow',
        card_font:'Interface font', card_font_desc:'Choose a font with good Cyrillic readability',
        card_size:'Size & spacing', card_size_desc:'Adjust comfortable text size',
        size_font_lbl:'Font size', size_spacing_lbl:'Line spacing',
        size_narrow:'Narrow', size_normal:'Normal', size_wide:'Wide',
        popup_stats: 'Stats', popup_topics: 'Topics', popup_mentions: 'Mentions',
        popup_open_all: 'Open all', popup_pinned: 'Pinned', popup_read_all: 'Read all',
        popup_empty: 'No unread topics', popup_last_update: 'Last update:',
    },
    de: {
        nav_fourpulse: '4Pulse',
        sec_fourpulse: '4Pulse',
        sec_fourpulse_desc: 'Exklusive Funktionen der 4Pulse-Erweiterung',
        card_radio: 'Radio',
        card_radio_desc: 'Radio direkt in der Erweiterung — wird beim Tab-Wechsel nicht unterbrochen',
        radio_enable: 'Radio-Player aktivieren',
        radio_enable_desc: 'Zeigt einen Mini-Player im Popup und Sidebar',
        radio_no_station: 'Kein Sender ausgewählt',
        radio_station_lbl: 'Sender',
        radio_select_station: '— Sender wählen —',
        radio_search_btn: 'Suchen',
        radio_custom_add: '+ Eigenen Sender hinzufügen',
        radio_custom_add_btn: 'Hinzufügen',
        radio_delete_custom: '🗑 Benutzerdefinierte Sender löschen',
        radio_mini_radio: '🎵 Radio',
        header_subtitle: 'Persönliche Einstellungen',
        nav_notifications: 'Benachrichtigungen',
        nav_sync: 'Synchronisation',
        nav_appearance: 'Erscheinungsbild',
        nav_about: 'Über',
        sec_notifications: 'Benachrichtigungen',
        sec_notifications_desc: 'Benachrichtigungen für verschiedene Ereignistypen konfigurieren',
        sec_sync: 'Synchronisation',
        sec_sync_desc: 'Wie oft neue Ereignisse und Nachrichten geprüft werden',
        sec_appearance: 'Erscheinungsbild',
        sec_appearance_desc: 'Design, Schrift, Farbe und Layout',
        sec_about: 'Über die Erweiterung',
        sec_about_desc: 'Version, Links und Danksagungen',
        card_language: '🌐 Oberflächensprache',
        card_language_desc: 'Sprache für alle Erweiterungsbeschriftungen wählen',
        tdesc_sound_qms:'Ton bei neuen privaten Nachrichten',
        tdesc_sound_topics:'Ton bei neuen Nachrichten in Favoriten-Themen',
        tdesc_sound_repeat:'Ton wiederholen, wenn ein weiterer Kommentar in einem ungelesenen Thema eintrifft',
        tdesc_sound_mentions:'Ton bei neuen Erwähnungen',
        tdesc_show_topics:'Einschließlich gelesener Themen aus Favoriten',
        tdesc_show_qms:'Einschließlich gelesener Gespräche',
        tdesc_show_mentions:'Einschließlich gelesener Erwähnungen',
        tdesc_hide_popup:'Popup beim Klick automatisch schließen und neuen Tab öffnen',
        tdesc_current_tab:'Themen, QMS und Erwähnungen öffnen im aktuellen Tab statt in neuen Tabs',
        tdesc_compact:'Kompakte Anzeige ohne Details',
        tdesc_bw_icons:'Farbe von Emoji-Icons für einen minimalistischen Look entfernen',
        hint_interval:'Empfohlen: 30 Sek. oder mehr. Häufige Anfragen können zu einer vorübergehenden Sperre führen (error 429).',
        hint_batch:'Begrenzung der Anzahl gleichzeitig geöffneter Tabs',
        card_dnd:'🌙 Nicht stören', card_dnd_desc:'Blockiert Benachrichtigungen und Töne zu bestimmten Zeiten',
        dnd_enable:'Nicht-stören-Modus aktivieren', dnd_enable_desc:'Benachrichtigungen erscheinen nicht während der gewählten Zeit',
        dnd_from:'Von', dnd_to:'Bis', dnd_days:'Tage',
        day_mon:'Mo', day_tue:'Di', day_wed:'Mi', day_thu:'Do', day_fri:'Fr', day_sat:'Sa', day_sun:'So',
        dnd_mentions:'Erwähnungen durchbrechen DND', dnd_mentions_desc:'@ Erwähnungs-Benachrichtigungen kommen auch in ruhigen Stunden',
        card_qms:'Nachrichten (QMS)', card_qms_desc:'Private Nachrichten im Forum',
        qms_all:'Alle Nachrichten', qms_all_desc:'Benachrichtigung bei jeder neuen Nachricht',
        qms_new:'Neue Gespräche', qms_new_desc:'Nur bei Beginn eines neuen Gesprächs',
        notify_off:'Keine Benachrichtigungen', notify_off_desc:'Benachrichtigungen deaktivieren',
        card_sound:'🔊 Benachrichtigungstöne', card_sound_desc:'Akustische Signale bei neuen Ereignissen',
        sound_qms_lbl:'📧 QMS (private Nachrichten)', sound_topics_lbl:'Themen',
        sound_all_comments:'Ton für jeden neuen Kommentar', sound_mentions_lbl:'Erwähnungen',
        sound_melody_qms:'🔔 Melodie für QMS', sound_melody_topics:'⭐ Melodie für Themen', sound_melody_mentions:'@ Melodie für Erwähnungen',
        sound_volume_lbl:'Lautstärke', sound_test:'🔊 Sound testen',
        snd_notify_desc:'Sanfter Benachrichtigungston', snd_excl_desc:'Kurz und aufmerksamkeitsstark',
        snd_fg_desc:'Angenehmer melodischer Klang', snd_bubble_desc:'Sanfte platzende Blase',
        snd_ping_desc:'Klares kurzes Ping', snd_chime_desc:'Sanftes Glockenspiel',
        snd_dong_desc:'Klassischer Doppelton', snd_whoosh_desc:'Energetisches aufsteigendes Rauschen',
        card_topics_notify:'Forum-Themen', card_topics_notify_desc:'Favoriten-Themen und Diskussionen',
        topics_notify_lbl:'Desktop-Benachrichtigungen',
        topics_all_comments:'Alle Kommentare', topics_new_pinned:'Neue Themen + Kommentare in angehefteten',
        topics_new_all:'Alle neuen Themen', topics_new_pinned_only:'Nur neue angeheftete Themen',
        card_mentions_notify:'Erwähnungen', card_mentions_notify_desc:'Wenn jemand Ihren Benutzernamen erwähnt',
        mentions_all:'Alle Erwähnungen', mentions_all_desc:'Benachrichtigung bei jeder Erwähnung',
        card_frequency:'Aktualisierungsrate', card_frequency_desc:'Häufigere Updates erhöhen die Serverlast',
        card_pinned:'Angeheftete Themen', card_pinned_desc:'Wie angeheftete Themen angezeigt werden',
        pinned_all:'Alle Themen zusammen', pinned_all_desc:'Angeheftete und normale Themen in einer Liste',
        pinned_top:'Angeheftete oben', pinned_top_desc:'Angeheftete Themen erscheinen zuerst',
        pinned_only:'Nur angeheftete', pinned_only_desc:'Nur angeheftete Themen anzeigen',
        card_popup_view:'Popup-Ansicht beim Öffnen', card_popup_view_desc:'Was beim Öffnen der Erweiterung angezeigt wird',
        popup_view_collapsed:'Eingeklappt (nur Statistik)', popup_view_collapsed_desc:'Nur Zähler anzeigen, keine Listen',
        popup_view_qms:'Tab "QMS" öffnen', popup_view_qms_desc:'QMS-Gespräche automatisch anzeigen',
        popup_view_topics:'Tab "Themen" öffnen', popup_view_topics_desc:'Themenliste automatisch anzeigen',
        popup_view_mentions:'Tab "Erwähnungen" öffnen', popup_view_mentions_desc:'Erwähnungen automatisch anzeigen',
        card_elements:'Elementanzeige', card_elements_desc:'Alle oder nur ungelesene Elemente anzeigen',
        card_interface_opt:'Interface-Optionen', card_interface_opt_desc:'Unnötige Interface-Elemente ausblenden', show_bookmarks_tab:'🔖 Lesezeichen-Tab anzeigen', tdesc_bookmarks_tab:'Lesezeichen-Kachel und Tab anzeigen', show_all_topics:'Alle Themen anzeigen', show_all_qms:'Alle QMS-Gespräche anzeigen', show_all_mentions:'Alle Erwähnungen anzeigen',
        card_buttons:'Aktionsschaltflächen', card_buttons_desc:'Massenaktions-Schaltflächen im Popup',
        btn_open_unread:'"Ungelesene Themen öffnen"', btn_open_unread_desc:'Massenöffnen-Schaltfläche anzeigen',
        btn_batch_size:'In Gruppen von', btn_batch_unit:'Themen öffnen',
        btn_read_all_lbl:'"Alle Themen als gelesen markieren"', btn_read_all_desc:'Massen-Gelesen-Schaltfläche anzeigen',
        card_open_topics:'Themen öffnen', card_open_topics_desc:'Wie Themen beim Klick geöffnet werden',
        open_hide_popup:'Popup nach dem Öffnen eines Themas schließen',
        open_current_tab:'Links im aktuellen Tab öffnen', open_compact:'Kompakte Themenlistenansicht',
        card_icons:'Icons', card_icons_desc:'Einstellungen für Emoji-Icons', icons_bw:'Schwarz-Weiß-Icons',
        card_accent:'Akzentfarbe', card_accent_desc:'Hervorhebungsfarbe für aktive Elemente',
        accent_blue:'🔵 Blau (4PDA)', accent_blue_desc:'4PDA-Forum-Stilfarbe',
        accent_teal:'🩵 Türkis', accent_teal_desc:'Frische türkis-grüne Farbe',
        accent_purple:'🟣 Lila', accent_purple_desc:'Elegant und modern',
        accent_orange:'🟠 Orange', accent_orange_desc:'Warm und positiv',
        card_theme:'Farbschema', card_theme_desc:'Helles oder dunkles Design wählen',
        theme_light:'☀️ Hell', theme_light_desc:'Klassisches helles Interface',
        theme_dark:'🌙 Dunkel', theme_dark_desc:'Augenschonend bei wenig Licht',
        theme_auto:'🌓 Auto', theme_auto_desc:'Systemdesign folgen',
        theme_glass:'✨ Liquid Glass', theme_glass_desc:'Glaseffekt mit Unschärfe und Schimmer — maximaler Stil', theme_cosmic:'🌌 Cosmic Pulse', theme_cosmic_desc:'Kosmischer Neon-Stil — tiefer dunkler Hintergrund mit Cyan-Glühen',
        card_font:'Schnittstellen-Schriftart', card_font_desc:'Schriftart mit guter kyrillischer Lesbarkeit wählen',
        card_size:'Größe & Abstände', card_size_desc:'Angenehme Textgröße einstellen',
        size_font_lbl:'Schriftgröße', size_spacing_lbl:'Zeilenabstand',
        size_narrow:'Eng', size_normal:'Normal', size_wide:'Weit',
        popup_stats: 'Statistik', popup_topics: 'Themen', popup_mentions: 'Erwähnungen',
        popup_open_all: 'Alle öffnen', popup_pinned: 'Angeheftet', popup_read_all: 'Alle gelesen',
        popup_empty: 'Keine ungelesenen Themen', popup_last_update: 'Letzte Aktualisierung:',
    },
    uk: {
        nav_fourpulse: '4Pulse',
        sec_fourpulse: '4Pulse',
        sec_fourpulse_desc: 'Ексклюзивні можливості розширення 4Pulse',
        card_radio: '🎵 Радіо',
        card_radio_desc: 'Слухай радіо прямо у розширенні — не переривається при зміні вкладок',
        radio_enable: 'Увімкнути радіоплеєр',
        radio_enable_desc: 'Показує міні-плеєр у попапі та сайдбарі',
        radio_no_station: 'Станцію не обрано',
        radio_station_lbl: 'Радіостанція',
        radio_select_station: '— Оберіть станцію —',
        radio_search_btn: 'Знайти',
        radio_custom_add: '+ Додати власну станцію',
        radio_custom_add_btn: 'Додати',
        radio_delete_custom: '🗑 Видалити користувацькі станції',
        radio_mini_radio: '🎵 Радіо',
        header_subtitle: 'Персональне налаштування',
        nav_notifications: 'Сповіщення',
        nav_sync: 'Синхронізація',
        nav_appearance: 'Зовнішній вигляд',
        nav_about: 'Про розширення',
        sec_notifications: 'Сповіщення',
        sec_notifications_desc: 'Налаштуйте сповіщення для різних типів подій',
        sec_sync: 'Синхронізація',
        sec_sync_desc: 'Як часто перевіряти нові події і повідомлення',
        sec_appearance: 'Зовнішній вигляд',
        sec_appearance_desc: 'Тема, шрифт, колір і розташування елементів',
        sec_about: 'Про розширення',
        sec_about_desc: 'Версія, посилання і подяки',
        card_language: '🌐 Мова інтерфейсу',
        card_language_desc: 'Оберіть мову для всіх написів розширення',
        tdesc_sound_qms:'Звук при нових приватних повідомленнях',
        tdesc_sound_topics:'Звук при нових повідомленнях в улюблених темах',
        tdesc_sound_repeat:'Відтворювати звук повторно, якщо в непрочитану тему прийшов ще один коментар',
        tdesc_sound_mentions:'Звук при нових згадках',
        tdesc_show_topics:'Включаючи прочитані теми з вибраного',
        tdesc_show_qms:'Включаючи прочитані діалоги',
        tdesc_show_mentions:'Включаючи прочитані згадки',
        tdesc_hide_popup:'Автоматично закривати попап при кліку і відкривати нову вкладку',
        tdesc_current_tab:'Теми, QMS і згадки відкриватимуться у поточній вкладці замість нових',
        tdesc_compact:'Компактне відображення без деталей',
        tdesc_bw_icons:'Прибрати колір з емодзі-іконок для мінімалістичного вигляду',
        hint_interval:'Рекомендується: 30 сек або більше. Часті запити можуть призвести до тимчасового блокування (error 429).',
        hint_batch:'Обмеження кількості вкладок, що відкриваються одночасно',
        popup_stats: 'Статистика', popup_topics: 'Теми', popup_mentions: 'Відповіді',
        popup_open_all: 'Відкрити всі', popup_pinned: 'Закріплені', popup_read_all: 'Прочитати всі',
        popup_empty: 'Непрочитаних тем немає', popup_last_update: 'Останнє оновлення:',
        // Settings cards
        card_dnd: '🌙 Не турбувати', card_dnd_desc: 'Блокує сповіщення і звуки у вказаний час',
        dnd_enable: 'Увімкнути режим «Не турбувати»',
        dnd_enable_desc: 'Сповіщення не з\'являтимуться у вибраний час',
        dnd_from: 'З', dnd_to: 'До', dnd_days: 'Дні',
        day_mon: 'Пн', day_tue: 'Вт', day_wed: 'Ср', day_thu: 'Чт', day_fri: 'Пт', day_sat: 'Сб', day_sun: 'Нд',
        dnd_mentions: 'Згадки пробивають DND',
        dnd_mentions_desc: '@ Сповіщення про згадки надходитимуть навіть у тихі години',
        card_qms: 'Повідомлення (QMS)', card_qms_desc: 'Приватні повідомлення на форумі',
        qms_all: 'Всі повідомлення', qms_all_desc: 'Сповіщати про кожне нове повідомлення',
        qms_new: 'Нові діалоги', qms_new_desc: 'Лише при початку нового діалогу',
        notify_off: 'Не сповіщати', notify_off_desc: 'Вимкнути сповіщення',
        card_sound: '🔊 Звук сповіщень', card_sound_desc: 'Звукові оповіщення про нові події',
        sound_qms_lbl: '📧 QMS (приватні повідомлення)', sound_topics_lbl: 'Теми',
        sound_all_comments: 'Звук на кожен новий коментар', sound_mentions_lbl: 'Згадки',
        sound_melody_qms: '🔔 Мелодія для QMS', sound_melody_topics: '⭐ Мелодія для тем',
        sound_melody_mentions: '@ Мелодія для згадок',
        sound_volume_lbl: 'Гучність', sound_test: '🔊 Перевірити звук',
        snd_notify_desc: 'М\'який звук сповіщення', snd_excl_desc: 'Короткий, що привертає увагу',
        snd_fg_desc: 'Приємний мелодійний звук', snd_bubble_desc: 'М\'яка бульбашка, що лопається',
        snd_ping_desc: 'Чіткий короткий пінг', snd_chime_desc: 'Ніжний передзвін дзвіночків',
        snd_dong_desc: 'Класичний подвійний тон', snd_whoosh_desc: 'Енергійний наростаючий свист',
        card_topics_notify: 'Теми форуму', card_topics_notify_desc: 'Улюблені теми та обговорення',
        topics_notify_lbl: 'Спливаючі сповіщення',
        topics_all_comments: 'Всі коментарі',
        topics_new_pinned: 'Нові теми + коментарі у закріплених',
        topics_new_all: 'Всі нові теми', topics_new_pinned_only: 'Лише нові закріплені теми',
        card_mentions_notify: 'Згадки', card_mentions_notify_desc: 'Коли хтось згадує ваш нік',
        mentions_all: 'Всі згадки', mentions_all_desc: 'Сповіщати про кожну згадку',
        card_frequency: 'Частота оновлення',
        card_frequency_desc: 'Частіші оновлення збільшують навантаження на сервер',
        card_pinned: 'Закріплені теми', card_pinned_desc: 'Як відображати закріплені теми',
        pinned_all: 'Всі теми разом',
        pinned_all_desc: 'Закріплені і звичайні теми в загальному списку',
        pinned_top: 'Закріплені зверху', pinned_top_desc: 'Закріплені теми показуються першими',
        pinned_only: 'Лише закріплені', pinned_only_desc: 'Показувати лише закріплені теми',
        card_popup_view: 'Вигляд попапу при відкритті',
        card_popup_view_desc: 'Що показувати при відкритті розширення',
        popup_view_collapsed: 'Згорнуто (лише статистика)',
        popup_view_collapsed_desc: 'Показати лише лічильники, без списків',
        popup_view_qms: 'Відкрити вкладку "QMS"',
        popup_view_qms_desc: 'Автоматично показати QMS-діалоги',
        popup_view_topics: 'Відкрити вкладку "Теми"',
        popup_view_topics_desc: 'Автоматично показати список тем',
        popup_view_mentions: 'Відкрити вкладку "Згадки"',
        popup_view_mentions_desc: 'Автоматично показати згадки',
        card_elements: 'Відображення елементів',
        card_elements_desc: 'Показувати всі елементи або лише непрочитані',
        show_all_topics: 'Показувати всі теми',
        show_all_qms: 'Показувати всі QMS-діалоги',
        show_all_mentions: 'Показувати всі згадки',
        card_buttons: 'Керуючі кнопки', card_buttons_desc: 'Кнопки масових дій у попапі',
        btn_open_unread: '"Відкрити непрочитані теми"',
        btn_open_unread_desc: 'Показати кнопку масового відкриття',
        btn_batch_size: 'Відкривати порціями по', btn_batch_unit: 'тем',
        btn_read_all_lbl: '"Позначити всі теми прочитаними"',
        btn_read_all_desc: 'Показати кнопку масового позначення',
        card_open_topics: 'Відкриття тем', card_open_topics_desc: 'Як відкривати теми при кліку',
        open_hide_popup: 'Приховувати попап після відкриття теми',
        open_current_tab: 'Відкривати посилання у поточній вкладці',
        open_compact: 'Спрощений вигляд списку тем',
        card_icons: 'Іконки', card_icons_desc: 'Налаштування відображення емодзі-іконок',
        icons_bw: 'Чорно-білі іконки',
        card_accent: 'Колір акценту', card_accent_desc: 'Колір підсвічування активних елементів',
        accent_blue: '🔵 Синій (4PDA)', accent_blue_desc: 'Колір у стилі форуму 4PDA',
        accent_teal: '🩵 Бірюзовий', accent_teal_desc: 'Свіжий бірюзово-зелений колір',
        accent_purple: '🟣 Фіолетовий', accent_purple_desc: 'Елегантний і сучасний',
        accent_orange: '🟠 Помаранчевий', accent_orange_desc: 'Теплий і позитивний',
        card_theme: 'Колірна схема', card_theme_desc: 'Оберіть світлу або темну тему',
        theme_light: '☀️ Світла', theme_light_desc: 'Класичний світлий інтерфейс',
        theme_dark: '🌙 Темна', theme_dark_desc: 'Комфорт для очей у темряві',
        theme_auto: '🌓 Авто', theme_auto_desc: 'Слідувати за системною темою',
        theme_glass: '✨ Liquid Glass',
        theme_glass_desc: 'Скляний ефект з розмиттям і переливами — максимально стильно',
        theme_cosmic: '🌌 Cosmic Pulse', theme_cosmic_desc: 'Космічний неоновий стиль — глибокий темний фон з ціановим сяйвом',
        card_font: 'Шрифт інтерфейсу',
        card_font_desc: 'Оберіть шрифт з хорошою читабельністю кирилиці',
        card_size: 'Розмір і відступи', card_size_desc: 'Налаштуйте комфортний розмір тексту',
        size_font_lbl: 'Розмір шрифту', size_spacing_lbl: 'Міжрядковий інтервал',
        size_narrow: 'Вузький', size_normal: 'Звичайний', size_wide: 'Широкий',
    }
};

function applyLanguage(lang) {
    const t = TRANSLATIONS[lang] || TRANSLATIONS['ru'];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (t[key]) el.textContent = t[key];
    });
}

async function initLanguageSelector() {
    const result = await chrome.storage.local.get(['ui_language']);
    const lang = result.ui_language || 'ru';
    document.querySelectorAll('input[name="ui_language"]').forEach(r => {
        r.checked = (r.value === lang);
    });
    applyLanguage(lang);

    document.querySelectorAll('input[name="ui_language"]').forEach(radio => {
        radio.addEventListener('change', async () => {
            await chrome.storage.local.set({ ui_language: radio.value });
            applyLanguage(radio.value);
        });
    });
}

document.addEventListener('DOMContentLoaded', initLanguageSelector);

// ─────────────────────────────────────────────────────────────
// 🎫 TICKETS — "Developer Options" style unlock
// ─────────────────────────────────────────────────────────────
(function initTickets() {
    const TAPS_NEEDED = 7;
    let tapCount = 0;
    let tapTimer = null;

    // ── Restore state on load ──────────────────────────────
    chrome.storage.local.get(['tickets_unlocked', 'tickets_enabled',
        'notification_tickets_level', 'sound_tickets', 'sound_file_tickets'])
        .then(data => {
            if (data.tickets_unlocked) showTicketsSection();

            const enabledCb = document.getElementById('tickets_enabled');
            if (enabledCb) enabledCb.checked = !!data.tickets_enabled;

            // notification level radio
            const nlVal = data.notification_tickets_level ?? 20;
            document.querySelectorAll('input[name="notification_tickets_level"]').forEach(r => {
                r.checked = (parseInt(r.value) === parseInt(nlVal));
            });

            const soundCb = document.getElementById('sound_tickets');
            if (soundCb) {
                soundCb.checked = !!data.sound_tickets;
                toggleTicketsSoundGroup(soundCb.checked);
            }

            const sfVal = data.sound_file_tickets || 'notify';
            document.querySelectorAll('input[name="sound_file_tickets"]').forEach(r => {
                r.checked = (r.value === sfVal);
            });
        });

    // ── Version tap listener (Easter egg) ──────────────────
    const versionEl = document.getElementById('about-version-tap');
    const hintEl    = document.getElementById('tickets-unlock-hint');
    if (versionEl) {
        versionEl.style.cursor = 'pointer';
        versionEl.addEventListener('click', async () => {
            const already = (await chrome.storage.local.get('tickets_unlocked')).tickets_unlocked;
            if (already) return;

            tapCount++;
            clearTimeout(tapTimer);
            tapTimer = setTimeout(() => { tapCount = 0; if (hintEl) hintEl.style.display = 'none'; }, 3000);

            const remaining = TAPS_NEEDED - tapCount;
            if (remaining > 0 && remaining < TAPS_NEEDED) {
                if (hintEl) {
                    hintEl.textContent = `Ещё ${remaining} ${remaining === 1 ? 'нажатие' : 'нажатия'} для разблокировки расширенных функций`;
                    hintEl.style.display = 'block';
                }
            }

            if (tapCount >= TAPS_NEEDED) {
                tapCount = 0;
                await chrome.storage.local.set({ tickets_unlocked: true });
                if (hintEl) {
                    hintEl.textContent = '🎫 Расширенные функции разблокированы!';
                    hintEl.style.color = 'var(--accent)';
                    hintEl.style.display = 'block';
                }
                showTicketsSection();
            }
        });
    }

    // ── Lock button ────────────────────────────────────────
    const lockBtn = document.getElementById('tickets-lock-btn');
    if (lockBtn) {
        lockBtn.addEventListener('click', async () => {
            await chrome.storage.local.set({ tickets_unlocked: false, tickets_enabled: false });
            hideTicketsSection();
            if (hintEl) { hintEl.style.display = 'none'; }
        });
    }

    // ── Settings listeners ─────────────────────────────────
    const enabledCb = document.getElementById('tickets_enabled');
    if (enabledCb) {
        enabledCb.addEventListener('change', () => {
            chrome.storage.local.set({ tickets_enabled: enabledCb.checked });
        });
    }

    document.querySelectorAll('input[name="notification_tickets_level"]').forEach(r => {
        r.addEventListener('change', () => {
            chrome.storage.local.set({ notification_tickets_level: parseInt(r.value) });
        });
    });

    const soundCb = document.getElementById('sound_tickets');
    if (soundCb) {
        soundCb.addEventListener('change', () => {
            chrome.storage.local.set({ sound_tickets: soundCb.checked });
            toggleTicketsSoundGroup(soundCb.checked);
        });
    }

    document.querySelectorAll('input[name="sound_file_tickets"]').forEach(r => {
        r.addEventListener('change', () => {
            chrome.storage.local.set({ sound_file_tickets: r.value });
        });
    });

    // ── Helpers ────────────────────────────────────────────
    function showTicketsSection() {
        // Simply reveal the card — no navigation, no scroll.
        // The user stays exactly where they are.
        const card = document.getElementById('tickets-settings-card');
        if (card) card.style.display = '';
    }

    function hideTicketsSection() {
        const card = document.getElementById('tickets-settings-card');
        if (card) card.style.display = 'none';
        // Disable tickets in storage
        chrome.storage.local.set({ tickets_enabled: false });
        const enabledCb = document.getElementById('tickets_enabled');
        if (enabledCb) enabledCb.checked = false;
    }

    function toggleTicketsSoundGroup(show) {
        const grp = document.getElementById('tickets_sound_group');
        if (grp) grp.style.display = show ? '' : 'none';
    }
})();

// ── Popup Width Slider ─────────────────────────────────────────
function initPopupWidthSlider() {
    const slider = document.getElementById('popup_width');
    const label  = document.getElementById('popup_width_label');
    if (!slider || !label) return;

    // Sync label on load (loadSettings sets slider.value, but label needs update)
    chrome.storage.local.get(['popup_width']).then(r => {
        const w = r.popup_width || 360;
        slider.value = w;
        label.textContent = w + 'px';
    });

    slider.addEventListener('input', function () {
        const w = parseInt(this.value);
        label.textContent = w + 'px';
        chrome.storage.local.set({ popup_width: w });
    });

    // ★ AUTO WIDTH checkbox
    const autoCheck = document.getElementById('popup_width_auto');
    if (autoCheck) {
        chrome.storage.local.get(['popup_width_auto']).then(r => {
            autoCheck.checked = !!r.popup_width_auto;
            slider.disabled = !!r.popup_width_auto;
            slider.style.opacity = autoCheck.checked ? '0.4' : '1';
        });
        autoCheck.addEventListener('change', function () {
            const isAuto = this.checked;
            chrome.storage.local.set({ popup_width_auto: isAuto });
            slider.disabled = isAuto;
            slider.style.opacity = isAuto ? '0.4' : '1';
        });
    }
}

// ══════════════════════════════════════════════════════════════════
// 💾 EXPORT / IMPORT SETTINGS
// ══════════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
    const statusEl = document.getElementById('settings-io-status');
    const setStatus = (msg, ok = true) => {
        if (!statusEl) return;
        statusEl.textContent = msg;
        statusEl.style.color = ok ? 'var(--text-3)' : '#f87171';
        setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 4000);
    };

    // ── Export ──
    document.getElementById('btn-export-settings')?.addEventListener('click', async () => {
        try {
            const data = await chrome.storage.local.get(null);
            // Remove non-settings keys
            const skip = ['tickets_cache_list','tickets_cache_timestamp','ticket_curator_cache',
                          'tickets_viewed_ids','focused_topics','muted_topics',
                          'cached_user_id','cached_user_name','auto_mode_active','priority_blinking',
                          'bm_cache','bm_collapsed_folders',
                          'tiles_order','new_topic_ids','known_topic_ids'];
            skip.forEach(k => delete data[k]);
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = `4pulse-settings-${new Date().toISOString().slice(0,10)}.json`;
            a.click();
            URL.revokeObjectURL(url);
            setStatus('✓ Настройки экспортированы');
        } catch (e) { setStatus('Ошибка экспорта: ' + e.message, false); }
    });

    // ── Import ──
    document.getElementById('import-file')?.addEventListener('change', async function () {
        const file = this.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Неверный формат');

            // Очищаем storage и записываем импортированные данные
            await chrome.storage.local.clear();
            await chrome.storage.local.set(data);

            // Уведомляем background чтобы обновил SETTINGS в памяти
            try { await chrome.runtime.sendMessage({ action: 'reload_settings' }); } catch(_) {}

            setStatus('✓ Настройки импортированы — перезагружаю...');
            setTimeout(() => location.reload(), 1200);
        } catch (e) { setStatus('Ошибка импорта: ' + e.message, false); }
        this.value = '';
    });
});

// ══════════════════════════════════════════════════════
// 🖼️ ICON PACK — Options page control
// ══════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => setTimeout(initIconPack, 120));

async function initIconPack() {
    const radios      = document.querySelectorAll('input[name="icon_pack"]');
    const customSec   = document.getElementById('custom-icon-pack-section');
    const entriesDiv  = document.getElementById('custom-icon-entries');
    const addBtn      = document.getElementById('icon-add-btn');
    const kwInput     = document.getElementById('icon-add-keyword');
    const valInput    = document.getElementById('icon-add-value');
    const importInput = document.getElementById('icon-pack-import');
    const exportBtn   = document.getElementById('icon-pack-export');
    const clearBtn    = document.getElementById('icon-pack-clear');

    if (!radios.length || !customSec) return;

    // ── Load current settings ──
    const stored = await chrome.storage.local.get(['icon_pack', 'custom_icon_pack']);
    const currentPack = stored.icon_pack || 'default';
    let customMap = stored.custom_icon_pack || {};

    // Set active radio
    radios.forEach(r => { r.checked = (r.value === currentPack); });
    customSec.style.display = (currentPack === 'custom') ? '' : 'none';

    // ── Toggle custom section visibility ──
    radios.forEach(r => r.addEventListener('change', async () => {
        const val = document.querySelector('input[name="icon_pack"]:checked')?.value || 'default';
        customSec.style.display = (val === 'custom') ? '' : 'none';
        await chrome.storage.local.set({ icon_pack: val });
    }));

    // ── Render entries ──
    function renderEntries() {
        entriesDiv.innerHTML = '';
        const entries = Object.entries(customMap);
        if (entries.length === 0) {
            entriesDiv.innerHTML = '<div style="font-size:11px;color:var(--text-3);padding:4px 0;">Пусто — добавьте пары «ключевое слово → иконка»</div>';
            return;
        }
        entries.forEach(([kw, icon]) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;border-radius:var(--radius-sm);background:var(--bg-secondary);border:1px solid var(--border);';

            // Preview
            const preview = document.createElement('span');
            preview.style.cssText = 'width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:14px;';
            if (icon.startsWith('data:') || icon.startsWith('http') || icon.startsWith('/')) {
                preview.innerHTML = `<img src="${icon}" style="width:18px;height:18px;border-radius:3px;object-fit:contain;">`;
            } else {
                preview.textContent = icon;
            }
            row.appendChild(preview);

            // Keyword
            const kwSpan = document.createElement('span');
            kwSpan.style.cssText = 'flex:1;font-size:12px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            kwSpan.textContent = kw;
            row.appendChild(kwSpan);

            // Value hint
            const valSpan = document.createElement('span');
            valSpan.style.cssText = 'font-size:10px;color:var(--text-3);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;';
            valSpan.textContent = icon.length > 12 ? icon.substring(0, 12) + '…' : icon;
            row.appendChild(valSpan);

            // Delete
            const delBtn = document.createElement('button');
            delBtn.textContent = '✕';
            delBtn.title = 'Удалить';
            delBtn.style.cssText = 'background:none;border:none;color:var(--text-3);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:3px;flex-shrink:0;';
            delBtn.addEventListener('click', async () => {
                delete customMap[kw];
                await saveCustomMap();
                renderEntries();
            });
            row.appendChild(delBtn);

            entriesDiv.appendChild(row);
        });
    }

    async function saveCustomMap() {
        await chrome.storage.local.set({ custom_icon_pack: customMap });
    }

    renderEntries();

    // ── Add entry ──
    addBtn?.addEventListener('click', async () => {
        const kw  = kwInput.value.trim();
        const val = valInput.value.trim();
        if (!kw || !val) return;
        customMap[kw] = val;
        await saveCustomMap();
        kwInput.value = '';
        valInput.value = '';
        renderEntries();
    });

    // ── Import JSON ──
    importInput?.addEventListener('change', async function () {
        const file = this.files[0];
        if (!file) return;
        try {
            const text = await file.text();
            const data = JSON.parse(text);
            if (typeof data !== 'object' || Array.isArray(data)) throw new Error('Ожидается JSON-объект { "ключ": "иконка" }');
            customMap = data;
            await saveCustomMap();
            renderEntries();
        } catch (e) {
            alert('Ошибка импорта: ' + e.message);
        }
        this.value = '';
    });

    // ── Export JSON ──
    exportBtn?.addEventListener('click', () => {
        const blob = new Blob([JSON.stringify(customMap, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = '4pulse-icon-pack.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    // ── Clear all ──
    clearBtn?.addEventListener('click', async () => {
        if (!confirm('Удалить все записи из иконопака?')) return;
        customMap = {};
        await saveCustomMap();
        renderEntries();
    });
}

/* ══════════════════════════════════════════════════════════════
   🔀 TILE ROW CONFIGURATOR
   Два ряда + «Скрытые». Drag-and-drop между зонами.
   Сохраняет tiles_row_config: { row1:[id,...], row2:[id,...] }
   Плитки без row-config используют tiles_order (popup drag-drop).
   ══════════════════════════════════════════════════════════════ */

const TILE_META = {
    'stat-qms':          { label: 'QMS',        icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
    'stat-favorites':    { label: 'Избранное',   icon: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>' },
    'stat-mentions':     { label: 'Упоминания',  icon: '<circle cx="12" cy="12" r="4"/><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"/>' },
    'stat-bookmarks':    { label: 'Закладки',    icon: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>' },
    'stat-tickets':      { label: 'Тикеты',      icon: '<path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/>' },
    'stat-radio-inline': { label: 'Радио',       icon: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49"/><path d="M7.76 7.76a6 6 0 0 0 0 8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>' },
};

const ALL_TILE_IDS = Object.keys(TILE_META);
const DEFAULT_ROW_CONFIG = { row1: ['stat-qms','stat-favorites','stat-mentions'], row2: ['stat-bookmarks','stat-tickets','stat-radio-inline'] };

let _rowConfig = JSON.parse(JSON.stringify(DEFAULT_ROW_CONFIG));
let _dragChip = null;

function makeChip(id) {
    const m = TILE_META[id];
    const chip = document.createElement('div');
    chip.className = 'tile-chip';
    chip.dataset.tileId = id;
    chip.draggable = true;
    chip.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${m.icon}</svg>${m.label}`;
    chip.addEventListener('dragstart', e => {
        _dragChip = chip;
        chip.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
    });
    chip.addEventListener('dragend', () => {
        chip.classList.remove('dragging');
        _dragChip = null;
    });
    return chip;
}

function renderConfigurator() {
    const zones = { row1: document.getElementById('tile-row-1'), row2: document.getElementById('tile-row-2'), hidden: document.getElementById('tile-row-hidden') };
    if (!zones.row1) return;
    Object.values(zones).forEach(z => z && (z.innerHTML = ''));

    const placed = [...(_rowConfig.row1||[]), ...(_rowConfig.row2||[])];
    const hidden = ALL_TILE_IDS.filter(id => !placed.includes(id));

    (_rowConfig.row1||[]).forEach(id => zones.row1.appendChild(makeChip(id)));
    (_rowConfig.row2||[]).forEach(id => zones.row2.appendChild(makeChip(id)));
    hidden.forEach(id => zones.hidden.appendChild(makeChip(id)));

    Object.entries(zones).forEach(([rowKey, zone]) => {
        if (!zone) return;
        zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
        zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
        zone.addEventListener('drop', e => {
            e.preventDefault();
            zone.classList.remove('drag-over');
            if (!_dragChip) return;
            const id = _dragChip.dataset.tileId;
            // Remove from current position
            ['row1','row2'].forEach(k => {
                _rowConfig[k] = (_rowConfig[k]||[]).filter(x => x !== id);
            });
            // Add to new row if not hidden, enforce max 3 per row
            if (rowKey === 'row1' || rowKey === 'row2') {
                if ((_rowConfig[rowKey]||[]).length < 5) {
                    if (!_rowConfig[rowKey]) _rowConfig[rowKey] = [];
                    _rowConfig[rowKey].push(id);
                }
            }
            // If dropped on a chip inside zone — insert before it
            if (_dragChip.parentElement === zone) return;
            renderConfigurator();
            saveRowConfig();
        });
        // Also support drop onto chips for reordering within a zone
        zone.querySelectorAll('.tile-chip').forEach(chip => {
            chip.addEventListener('dragover', e => { e.preventDefault(); chip.style.outline = '2px solid var(--accent)'; });
            chip.addEventListener('dragleave', () => chip.style.outline = '');
            chip.addEventListener('drop', e => {
                e.preventDefault();
                chip.style.outline = '';
                if (!_dragChip || _dragChip === chip) return;
                const srcId = _dragChip.dataset.tileId;
                const dstId = chip.dataset.tileId;
                // Find which row dst is in
                const dstRow = Object.entries(_rowConfig).find(([k,arr]) => arr?.includes(dstId))?.[0];
                if (!dstRow) return;
                // Remove src from current row
                ['row1','row2'].forEach(k => { _rowConfig[k] = (_rowConfig[k]||[]).filter(x => x !== srcId); });
                // Insert before dst
                const arr = _rowConfig[dstRow];
                const di = arr.indexOf(dstId);
                if ((_rowConfig[dstRow]||[]).length < 5 || dstRow === Object.entries(_rowConfig).find(([k,a]) => a?.includes(srcId))?.[0]) {
                    arr.splice(di, 0, srcId);
                }
                renderConfigurator();
                saveRowConfig();
            });
        });
    });
}

function saveRowConfig() {
    chrome.storage.local.set({ tiles_row_config: _rowConfig });
    // Also sync tiles_order for popup drag-drop compatibility
    const order = [...(_rowConfig.row1||[]), ...(_rowConfig.row2||[])];
    const hidden = ALL_TILE_IDS.filter(id => !order.includes(id));
    chrome.storage.local.set({ tiles_order: [...order, ...hidden] });
}

async function initTileConfigurator() {
    const r = await chrome.storage.local.get(['tiles_row_config']);
    if (r.tiles_row_config?.row1) {
        _rowConfig = r.tiles_row_config;
    }
    renderConfigurator();
    const resetBtn = document.getElementById('tile-rows-reset');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            _rowConfig = JSON.parse(JSON.stringify(DEFAULT_ROW_CONFIG));
            renderConfigurator();
            saveRowConfig();
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initTileConfigurator();
});
