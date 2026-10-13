<script lang="ts" setup>
import type { AttachmentResType } from 'nocodb-sdk'

interface Props {
  logoUrl?: AttachmentResType | string | null
}
const props = defineProps<Props>()

const { getPossibleAttachmentSrc } = useAttachment()

const logoSrc = computed(() => getPossibleAttachmentSrc(parseProp(props.logoUrl)))
</script>

<template>
  <div v-if="logoUrl" class="nc-form-logo-wrapper h-56px max-w-189px inline-flex items-center overflow-hidden">
    <LazyCellAttachmentPreviewImage
      :key="parseProp(logoUrl)?.path"
      :srcs="logoSrc"
      class="flex-none nc-form-logo !object-contain object-left max-h-full max-w-full !m-0"
      :is-cell-preview="false"
    />
  </div>
</template>
