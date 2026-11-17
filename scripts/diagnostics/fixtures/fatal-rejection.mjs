// Real child-process regression; the handler deliberately hides error details.
process.on('unhandledRejection', () => {
  console.error('FATAL_UNHANDLED_REJECTION');
  process.exit(1);
});
Promise.reject(new Error('secret https://host/?key=secret', { cause: 'secret' }));
