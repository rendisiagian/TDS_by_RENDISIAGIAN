// ==================================================
// TOAST NOTIFICATION SYSTEM
// Replaces native alert() and confirm() with modern UI
// ==================================================

(function() {
    'use strict';

    // --- Ensure toast container exists ---
    function ensureContainer() {
        var container = document.getElementById('toast-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toast-container';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }
        return container;
    }

    // --- Icon map ---
    var ICONS = {
        success: '\u2705',
        error:   '\u274C',
        warning: '\u26A0\uFE0F',
        info:    '\u2139\uFE0F'
    };

    // ==================================================
    // showToast(message, type, duration)
    // type: 'success' | 'error' | 'warning' | 'info'
    // duration: ms (default 4000)
    // ==================================================
    window.showToast = function(message, type, duration) {
        type = type || 'info';
        duration = duration || 4000;

        var container = ensureContainer();

        var toast = document.createElement('div');
        toast.className = 'toast toast-' + type;

        var icon = ICONS[type] || ICONS.info;

        toast.innerHTML =
            '<span class="toast-icon">' + icon + '</span>' +
            '<div class="toast-body"><div class="toast-msg">' + message + '</div></div>' +
            '<button class="toast-close" onclick="this.closest(\'.toast\').remove()">&times;</button>' +
            '<div class="toast-bar" style="animation-duration:' + duration + 'ms"></div>';

        container.appendChild(toast);

        // Auto remove
        var timer = setTimeout(function() {
            toast.classList.add('toast-out');
            setTimeout(function() { toast.remove(); }, 300);
        }, duration);

        // Pause on hover
        toast.addEventListener('mouseenter', function() {
            clearTimeout(timer);
            toast.querySelector('.toast-bar').style.animationPlayState = 'paused';
        });

        toast.addEventListener('mouseleave', function() {
            timer = setTimeout(function() {
                toast.classList.add('toast-out');
                setTimeout(function() { toast.remove(); }, 300);
            }, 2000);
            toast.querySelector('.toast-bar').style.animationPlayState = 'running';
        });

        return toast;
    };

    // ==================================================
    // showConfirm(message, onConfirm, options)
    // options: { title, danger, onCancel }
    // Non-blocking replacement for confirm()
    // ==================================================
    window.showConfirm = function(message, onConfirm, options) {
        options = options || {};
        var title = options.title || 'Konfirmasi';
        var danger = options.danger || false;
        var onCancel = options.onCancel || null;

        var overlay = document.createElement('div');
        overlay.className = 'toast-confirm-overlay';

        var dangerClass = danger ? ' btn-danger' : '';

        overlay.innerHTML =
            '<div class="toast-confirm-dialog">' +
                '<h4>\u26A0\uFE0F ' + title + '</h4>' +
                '<p>' + message + '</p>' +
                '<div class="toast-confirm-btns">' +
                    '<button class="btn-confirm-no">Batal</button>' +
                    '<button class="btn-confirm-yes' + dangerClass + '">Ya, Lanjutkan</button>' +
                '</div>' +
            '</div>';

        document.body.appendChild(overlay);

        var yesBtn = overlay.querySelector('.btn-confirm-yes');
        var noBtn  = overlay.querySelector('.btn-confirm-no');

        function close() {
            overlay.style.opacity = '0';
            overlay.style.transition = 'opacity 0.2s';
            setTimeout(function() { overlay.remove(); }, 200);
        }

        yesBtn.addEventListener('click', function() {
            close();
            if (typeof onConfirm === 'function') onConfirm();
        });

        noBtn.addEventListener('click', function() {
            close();
            if (typeof onCancel === 'function') onCancel();
        });

        // Close on overlay click
        overlay.addEventListener('click', function(e) {
            if (e.target === overlay) {
                close();
                if (typeof onCancel === 'function') onCancel();
            }
        });

        // Close on Escape key
        function onKey(e) {
            if (e.key === 'Escape') {
                close();
                if (typeof onCancel === 'function') onCancel();
                document.removeEventListener('keydown', onKey);
            }
        }
        document.addEventListener('keydown', onKey);
    };

    // ==================================================
    // Mobile Hamburger Menu Controller
    // ==================================================
    window.__toggleMobileSidebar = function() {
        var sidebar = document.querySelector('.sidebar');
        var backdrop = document.getElementById('sidebar-backdrop');
        if (!sidebar) return;

        var isOpen = sidebar.classList.toggle('sidebar-open');

        if (!backdrop) {
            backdrop = document.createElement('div');
            backdrop.id = 'sidebar-backdrop';
            backdrop.className = 'sidebar-backdrop';
            backdrop.onclick = function() { window.__toggleMobileSidebar(); };
            document.body.appendChild(backdrop);
        }

        if (isOpen) {
            backdrop.classList.add('active');
        } else {
            backdrop.classList.remove('active');
        }
    };

    // ==================================================
    // showLoading(containerId, text) / hideLoading(containerId)
    // Utility for loading states
    // ==================================================
    window.showLoading = function(containerId, text) {
        var el = document.getElementById(containerId);
        if (!el) return;
        el.innerHTML =
            '<div class="loading-overlay">' +
                '<div class="loading-spinner"></div>' +
                '<div class="loading-text">' + (text || 'Memuat data...') + '</div>' +
            '</div>';
    };

    window.hideLoading = function(containerId) {
        var el = document.getElementById(containerId);
        if (!el) return;
        var overlay = el.querySelector('.loading-overlay');
        if (overlay) overlay.remove();
    };

})();
