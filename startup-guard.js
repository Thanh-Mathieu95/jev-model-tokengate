// Import ĐẦU TIÊN trong server.js. ESM đánh giá module theo thứ tự import, nên
// handler này được gắn trước khi criteria.js nạp config — lỗi chính sách sẽ hiện
// ra một dòng đọc được thay vì stack trace.
process.on('uncaughtException', (err) => {
  console.error(`\n[tokengate] không khởi động được: ${err.message}\n`);
  console.error('Xem tokengate.config.example.json để biết cấu trúc đúng.\n');
  process.exit(1);
});
