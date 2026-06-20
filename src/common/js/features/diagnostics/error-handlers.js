export function registerGlobalErrorHandlers({
    target = globalThis,
    logger = console,
    addEventLog = () => {},
} = {}) {
    target.addEventListener('unhandledrejection', event => {
        logger.error('🚨 Unhandled promise rejection:', {
            reason: event.reason,
            promise: event.promise,
        });
        event.preventDefault();
        try {
            addEventLog('error', 'Unhandled promise rejection', 'error', {
                reason: String(event.reason?.message || event.reason || ''),
            });
        } catch (_) {}
    });

    target.addEventListener('error', event => {
        logger.error('🚨 Global error:', {
            message: event.message,
            filename: event.filename,
            lineno: event.lineno,
            colno: event.colno,
            error: event.error,
        });
        try {
            addEventLog('error', 'Global JS error', 'error', {
                message: String(event.message || ''),
                filename: event.filename || '',
                lineno: event.lineno || 0,
            });
        } catch (_) {}
    });
}
