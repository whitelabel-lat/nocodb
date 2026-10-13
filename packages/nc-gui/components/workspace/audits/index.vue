<script lang="ts" setup>
// CE implementation (whitelabel fork). Workspace settings (no baseId) and base settings (baseId).
const props = defineProps<{ baseId?: string }>()
</script>

<template>
  <AuditLog :scope="props.baseId ? 'base' : 'workspace'" :base-id="props.baseId" />
</template>
