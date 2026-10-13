<script lang="ts" setup>
// CE implementation (whitelabel fork)
</script>

<template>
  <div class="h-full flex flex-col w-full" data-testid="nc-instance-admin-audit">
    <NcPageHeader>
      <template #icon>
        <GeneralIcon icon="audit" class="flex-none h-5 w-5" />
      </template>
      <template #title>
        <span data-rec="true">{{ $t('auditLog.instanceTitle') }}</span>
      </template>
    </NcPageHeader>
    <div class="flex-1 min-h-0 max-h-[calc(100vh_-_100px)]">
      <AuditLog scope="instance" />
    </div>
  </div>
</template>
