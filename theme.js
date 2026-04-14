// Dark Mode & Theme Management
(function() {
    var t = localStorage.getItem('theme') || 'light';
    document.documentElement.setAttribute('data-theme', t);
})();

window.__toggleDarkMode = function() {
    var html = document.documentElement;
    var current = html.getAttribute('data-theme') || 'light';
    var next = (current === 'dark') ? 'light' : 'dark';
    html.setAttribute('data-theme', next);
    localStorage.setItem('theme', next);
    var iconEl = document.getElementById('dm-icon');
    var textEl = document.getElementById('dm-text');
    if (iconEl && textEl) {
        iconEl.textContent = (next === 'dark') ? '\u2600\ufe0f' : '\ud83c\udf19';
        textEl.textContent = (next === 'dark') ? 'Light Mode' : 'Dark Mode';
    }
};

// Load user info and display in header
document.addEventListener('DOMContentLoaded', function() {
    fetch('/api/me').then(function(r) { return r.json(); }).then(function(user) {
        var el = document.getElementById('header-user-name');
        if (el && user && user.nama) {
            el.textContent = user.nama;
        }
        // Also update manage_users page
        var el2 = document.getElementById('user-name-display');
        if (el2 && user && user.nama) {
            el2.textContent = user.nama;
        }
    }).catch(function() {});
});
