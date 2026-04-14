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
