// بيبني assets/tailwind.css من الكلاسات المستخدمة في index.html (بدل Tailwind CDN اللي كان بيبني الستايل على الجهاز كل مرة).
// بعد أي تعديل فيه كلاسات Tailwind جديدة، شغّل من جذر المشروع:
//   npx tailwindcss@3.4.17 -c tools/tailwind/tailwind.config.js -i tools/tailwind/input.css -o assets/tailwind.css --minify
// (tests/static-checks... و GitHub Actions بيفشلوا لو الملف مش متحدّث)
module.exports = {
  content: ['./index.html'],
  safelist: [],
};
