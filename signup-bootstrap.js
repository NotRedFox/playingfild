try {
  if (typeof pfBootstrapDashboardTheme === 'function') {
    pfBootstrapDashboardTheme();
  } else {
    document.documentElement.classList.add('fonts-ready');
  }
} catch (_) {
  document.documentElement.classList.add('fonts-ready');
}
