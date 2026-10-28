// هجرة من JSON الملفات إلى PostgreSQL
// يمكن تشغيله كـ "npm import" لجلب جميع ملفات JSON من نظام التخزين القديم
// ويدرجها في PostgreSQL مع دعم dry-run والحفاظ على التكرار

const fs = require("fs");
const path = require("path");
const storage = require("./storage");

async function run(dryRun = false, verbose = false) {
  console.log("بدء عملية الاستيراد من نظام التخزين القديم...");

  // تحديد موقع البيانات القديمة
  const dataDir = process.env.DATA_DIR || path.join(__dirname, "..", "data");
  const submissionsDir = path.join(dataDir, "submissions");

  if (!fs.existsSync(submissionsDir)) {
    console.log(`لا يوجد دليل بيانات: ${submissionsDir}`);
    console.log("لا حاجة للاستيراد - النظام يستخدم PostgreSQL بالفعل.");
    return;
  }

  // جلب جميع ملفات JSON
  const files = fs.readdirSync(submissionsDir)
    .filter(f => f.endsWith(".json"))
    .sort();

  console.log(`وجد ${files.length} ملفًا في ${submissionsDir}`);

  if (dryRun) {
    console.log("وضع التنفيذ: DRY-RUN - لن يتم كتابة أي شيء إلى قاعدة البيانات");
    files.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    return;
  }

  let imported = 0;
  let duplicates = 0;
  let errors = 0;

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(submissionsDir, file), "utf8");
      const data = JSON.parse(content);

      if (verbose) {
        console.log(`المعالجة: ${file} (المعرف: ${data.id || "غير معروف"})`);
      }

      // محاولة الإدراج
      const result = await storage.save(data);

      if (result.ok) {
        imported++;
        if (result.duplicate) duplicates++;
        if (verbose) console.log(`✓ تم الإدراج: ${file}`);
      } else {
        errors++;
        if (verbose) console.log(`✗ فشل الإدراج: ${file} - ${result.error || "خطأ غير معروف"}`);
      }
    } catch (err) {
      errors++;
      console.error(`✗ خطأ في معالجة ${file}: ${err.message}`);
    }
  }

  console.log("\nملخص الاستيراد:");
  console.log(`  ✓ تم الإدراج: ${imported}`);
  if (duplicates) console.log(`  🔄 تكرارات تم تجاهلها: ${duplicates}`);
  console.log(`  ✗ أخطاء: ${errors}`);
  console.log("\nاكتمل الاستيراد.");
}

if (require.main === module) {
  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");
  run(dryRun, verbose).catch(console.error);
}

module.exports = { run };