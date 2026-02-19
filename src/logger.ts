

export const logInfo = (message: string): void => {
  console.info(`ℹ️  ${message}`);
};

export const logSuccess = (message: string): void => {
  console.info(`✅ ${message}`);
};

export const logError = (message: string): void => {
  console.error(`❌ ${message}`);
};

export const logProgress = (current: number, total: number, item: string): void => {
  const percentage = total > 0 ? Math.round((current / total) * 100) : 0;
  console.info(`[${current}/${total}] (${percentage}%) ${item}`);
};

export const logSection = (title: string): void => {
  console.info('\n' + '─'.repeat(50));
  console.info(`📋 ${title}`);
  console.info('─'.repeat(50));
};

export const logSummary = (stats: {
  total: number;
  downloaded: number;
  failed: number;
  failures: ReadonlyArray<{ ref: { name: string; id: string }; error: string }>;
}): void => {
  console.info('\n' + '═'.repeat(50));
  console.info('📊 RESUMO FINAL');
  console.info('═'.repeat(50));
  console.info(`Total encontrados: ${stats.total}`);
  console.info(`✅ Baixados com sucesso: ${stats.downloaded}`);
  console.info(`❌ Falhas: ${stats.failed}`);

  if (stats.failures.length > 0) {
    console.info('\n📝 Detalhes das falhas:');
    stats.failures.forEach((failure) => {
      console.info(`  • ${failure.ref.name} (${failure.ref.id})`);
      console.info(`    Erro: ${failure.error}`);
    });
  }
  console.info('═'.repeat(50) + '\n');
};
