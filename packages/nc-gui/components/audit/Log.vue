<script lang="ts" setup>
// CE implementation (whitelabel fork)
import { AuditV1OperationTypes, NO_SCOPE } from 'nocodb-sdk'
import dayjs from 'dayjs'

interface Props {
  /** instance: every workspace (admin panel) · workspace: the active workspace · base: one base */
  scope: 'instance' | 'workspace' | 'base'
  baseId?: string
}

const props = defineProps<Props>()

const { $api } = useNuxtApp()

const { t } = useI18n()

const { appInfo } = useGlobal()

const { activeWorkspaceId } = storeToRefs(useWorkspace())

const { base: activeBase } = storeToRefs(useBase())

const { bases: instanceBases, fetchBases } = useInstanceAdmin()

const tablesStore = useTablesStore()

const { baseTables } = storeToRefs(tablesStore)

const operation = computed(() =>
  props.scope === 'instance' ? 'instanceAuditList' : props.scope === 'workspace' ? 'workspaceAuditList' : 'baseAuditList',
)

const PAGE_SIZE_OPTIONS = [25, 50, 100]

const isLoading = ref(false)
const hasError = ref(false)
const rows = ref<Record<string, any>[]>([])
const limit = ref(25)

// Keyset pagination: `cursors[i]` is the cursor that opens page i + 1.
const cursors = ref<(string | null)[]>([null])
const pageIndex = ref(0)
const nextCursor = ref<string | null>(null)

const filters = reactive({
  user: '',
  baseId: undefined as string | undefined,
  tableId: undefined as string | undefined,
  opTypes: [] as string[],
  range: 'any' as 'any' | '24h' | '7d' | '30d' | 'custom',
  custom: undefined as [any, any] | undefined,
})

const selectedBaseId = computed(() => (props.scope === 'base' ? props.baseId : filters.baseId))

const baseOptions = computed(() => {
  if (props.scope === 'base') return []
  return instanceBases.value.map((b) => ({ value: b.id, label: b.title }))
})

const tableOptions = computed(() =>
  (selectedBaseId.value ? baseTables.value.get(selectedBaseId.value) ?? [] : []).map((tbl: any) => ({
    value: tbl.id,
    label: tbl.title,
  })),
)

const opTypeOptions = computed(() =>
  Object.values(AuditV1OperationTypes)
    .map((v) => String(v))
    .sort()
    .map((v) => ({ value: v, label: v.replace(/_/g, ' ').toLowerCase() })),
)

const rangeBounds = computed(() => {
  const now = dayjs()
  switch (filters.range) {
    case '24h':
      return { from: now.subtract(24, 'hour') }
    case '7d':
      return { from: now.subtract(7, 'day') }
    case '30d':
      return { from: now.subtract(30, 'day') }
    case 'custom':
      return {
        from: filters.custom?.[0] ? dayjs(filters.custom[0]).startOf('day') : undefined,
        to: filters.custom?.[1] ? dayjs(filters.custom[1]).endOf('day') : undefined,
      }
    default:
      return {}
  }
})

async function load() {
  isLoading.value = true
  hasError.value = false
  try {
    const { from, to } = rangeBounds.value as { from?: dayjs.Dayjs; to?: dayjs.Dayjs }

    const base = activeBase.value
    const workspaceId =
      props.scope === 'instance' ? NO_SCOPE : props.scope === 'base' ? base?.fk_workspace_id ?? NO_SCOPE : activeWorkspaceId.value
    const baseId = props.scope === 'base' ? props.baseId ?? base?.id : NO_SCOPE

    const res: any = await $api.internal.getOperation(
      workspaceId,
      baseId as string,
      {
        operation: operation.value,
        limit: limit.value,
        cursor: cursors.value[pageIndex.value] ?? undefined,
        user: filters.user.trim() || undefined,
        base_id: props.scope === 'base' ? undefined : filters.baseId,
        fk_model_id: filters.tableId,
        op_type: filters.opTypes.length ? filters.opTypes.join(',') : undefined,
        from: from?.toISOString(),
        to: to?.toISOString(),
      } as any,
    )

    rows.value = res.list ?? []
    nextCursor.value = res.pageInfo?.nextCursor ?? null
  } catch (e: any) {
    console.error(e)
    hasError.value = true
    rows.value = []
    nextCursor.value = null
    message.error(await extractSdkResponseErrorMsg(e))
  } finally {
    isLoading.value = false
  }
}

function resetAndLoad() {
  cursors.value = [null]
  pageIndex.value = 0
  return load()
}

function goNext() {
  if (!nextCursor.value) return
  cursors.value[pageIndex.value + 1] = nextCursor.value
  pageIndex.value++
  load()
}

function goPrevious() {
  if (pageIndex.value === 0) return
  pageIndex.value--
  load()
}

// Debounce free-text, everything else reloads at once.
const debouncedUser = refDebounced(toRef(filters, 'user'), 400)
watch(debouncedUser, resetAndLoad)
watch(() => [filters.baseId, filters.tableId, filters.opTypes, filters.range, filters.custom, limit.value], resetAndLoad, {
  deep: true,
})

watch(
  () => filters.baseId,
  async (id) => {
    filters.tableId = undefined
    if (id) await tablesStore.loadProjectTables(id)
  },
)

watch(
  () => props.baseId,
  (id) => {
    if (id) tablesStore.loadProjectTables(id)
    resetAndLoad()
  },
)

onMounted(async () => {
  if (props.scope === 'instance') fetchBases()
  if (props.scope === 'base' && props.baseId) tablesStore.loadProjectTables(props.baseId)
  await load()
})

const columns = computed<NcTableColumnProps[]>(() => [
  { key: 'created_at', title: t('auditLog.time'), width: 170, minWidth: 170 },
  { key: 'user', title: t('auditLog.user'), minWidth: 200 },
  ...(props.scope === 'base' ? [] : [{ key: 'base', title: t('auditLog.base'), minWidth: 160 }]),
  { key: 'table', title: t('auditLog.table'), minWidth: 160 },
  { key: 'op', title: t('auditLog.operation'), minWidth: 190 },
  { key: 'description', title: t('general.description'), minWidth: 260 },
  { key: 'actions', title: '', width: 56, minWidth: 56 },
])

const formatTime = (v: string) => dayjs(v).format('YYYY-MM-DD HH:mm:ss')

const opLabel = (r: Record<string, any>) => [r.op_type, r.op_sub_type].filter(Boolean).join(' / ').replace(/_/g, ' ')

// ── Detail ────────────────────────────────────────────────────────────────
const selected = ref<Record<string, any> | null>(null)
const isDetailOpen = computed({
  get: () => !!selected.value,
  set: (v) => {
    if (!v) selected.value = null
  },
})

const parsedDetails = computed<any>(() => {
  const d = selected.value?.details
  if (!d) return null
  try {
    return JSON.parse(d)
  } catch {
    return { raw: d }
  }
})

const changes = computed(() => {
  const d = parsedDetails.value
  if (!d || typeof d !== 'object' || (!d.data && !d.old_data)) return []
  const keys = new Set([...Object.keys(d.data ?? {}), ...Object.keys(d.old_data ?? {})])
  return [...keys].map((k) => ({ field: d.column_meta?.[k]?.title ?? k, before: d.old_data?.[k], after: d.data?.[k] }))
})

const show = (v: unknown) =>
  v === null || v === undefined || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)

// Record audits carry no description; list the fields they touched instead.
const summary = (r: Record<string, any>) => {
  if (r.description) return r.description
  try {
    const d = JSON.parse(r.details ?? 'null')
    const keys = Object.keys(d?.data ?? d?.old_data ?? {}).map((k) => d.column_meta?.[k]?.title ?? k)
    return keys.length ? keys.join(', ') : ''
  } catch {
    return ''
  }
}

const recordLink = (r: Record<string, any>) =>
  r.base_id && r.fk_model_id && r.row_id && String(r.op_type).startsWith('DATA') && !String(r.op_type).includes('BULK')
    ? `/nc/${r.base_id}/${r.fk_model_id}?rowId=${encodeURIComponent(r.row_id)}`
    : undefined
</script>

<template>
  <div class="flex flex-col gap-4 h-full min-h-0 p-6" data-testid="nc-audit-log">
    <div v-if="!appInfo.auditEnabled" class="text-nc-content-red-medium">{{ $t('auditLog.disabled') }}</div>

    <div class="flex flex-wrap items-center gap-2">
      <a-input
        v-model:value="filters.user"
        allow-clear
        :placeholder="$t('auditLog.filterUser')"
        class="!w-72 !h-8 !rounded-lg"
        data-testid="nc-audit-filter-user"
      >
        <template #prefix>
          <GeneralIcon icon="search" class="h-4 w-4 text-nc-content-gray-muted" />
        </template>
      </a-input>

      <NcSelect
        v-if="scope !== 'base'"
        v-model:value="filters.baseId"
        allow-clear
        show-search
        :placeholder="$t('auditLog.allBases')"
        :filter-option="(input: string, option: any) => `${option.label}`.toLowerCase().includes(input.toLowerCase())"
        class="!w-48"
        data-testid="nc-audit-filter-base"
      >
        <a-select-option v-for="o of baseOptions" :key="o.value" :value="o.value" :label="o.label">{{ o.label }}</a-select-option>
      </NcSelect>

      <NcSelect
        v-model:value="filters.tableId"
        allow-clear
        show-search
        :placeholder="$t('auditLog.allTables')"
        :filter-option="(input: string, option: any) => `${option.label}`.toLowerCase().includes(input.toLowerCase())"
        class="!w-48"
        data-testid="nc-audit-filter-table"
      >
        <a-select-option v-for="o of tableOptions" :key="o.value" :value="o.value" :label="o.label">{{
          o.label
        }}</a-select-option>
      </NcSelect>

      <NcSelect
        v-model:value="filters.opTypes"
        mode="multiple"
        allow-clear
        show-search
        :max-tag-count="1"
        :placeholder="$t('auditLog.allOperations')"
        :filter-option="(input: string, option: any) => `${option.value}`.toLowerCase().includes(input.toLowerCase().replace(/ /g, '_'))"
        class="!w-60"
        data-testid="nc-audit-filter-op"
      >
        <a-select-option v-for="o of opTypeOptions" :key="o.value" :value="o.value">{{ o.label }}</a-select-option>
      </NcSelect>

      <NcSelect v-model:value="filters.range" class="!w-44" data-testid="nc-audit-filter-range">
        <a-select-option value="any">{{ $t('auditLog.rangeAny') }}</a-select-option>
        <a-select-option value="24h">{{ $t('auditLog.rangeLast24h') }}</a-select-option>
        <a-select-option value="7d">{{ $t('auditLog.rangeWeek') }}</a-select-option>
        <a-select-option value="30d">{{ $t('auditLog.rangeMonth') }}</a-select-option>
        <a-select-option value="custom">{{ $t('auditLog.rangeCustom') }}</a-select-option>
      </NcSelect>
      <a-range-picker v-if="filters.range === 'custom'" v-model:value="filters.custom" class="!h-8 !rounded-lg" />

      <span class="flex-1" />
      <NcButton size="small" type="secondary" :loading="isLoading" data-testid="nc-audit-reload" @click="load">
        <div class="flex items-center gap-2">
          <GeneralIcon icon="reload" />
          {{ $t('general.reload') }}
        </div>
      </NcButton>
    </div>

    <div class="flex-1 min-h-0 flex flex-col">
      <NcTable
        :columns="columns"
        :data="rows"
        :is-data-loading="isLoading"
        :bordered="false"
        row-height="48px"
        class="flex-1 min-h-0"
        data-testid="nc-audit-log-table"
        :custom-row="(record: any) => ({ onClick: () => (selected = record) })"
      >
        <template #emptyText>
          <div class="py-12 text-nc-content-gray-muted text-center">
            {{ hasError ? $t('auditLog.loadError') : $t('auditLog.empty') }}
          </div>
        </template>
        <template #bodyCell="{ column, record }">
          <span v-if="column.key === 'created_at'" class="text-nc-content-gray-subtle2 whitespace-nowrap">
            {{ formatTime(record.created_at) }}
          </span>
          <NcTooltip v-else-if="column.key === 'user'" class="truncate max-w-full" show-on-truncate-only>
            <template #title>{{ record.user }}</template>
            {{ record.user || '—' }}
          </NcTooltip>
          <NcTooltip v-else-if="column.key === 'base'" class="truncate max-w-full" show-on-truncate-only>
            <template #title>{{ record.base_title }}</template>
            {{ record.base_title || '—' }}
          </NcTooltip>
          <NcTooltip v-else-if="column.key === 'table'" class="truncate max-w-full" show-on-truncate-only>
            <template #title>{{ record.table_title }}</template>
            {{ record.table_title || '—' }}
          </NcTooltip>
          <span v-else-if="column.key === 'op'" class="font-medium capitalize">{{ opLabel(record).toLowerCase() }}</span>
          <NcTooltip v-else-if="column.key === 'description'" class="truncate max-w-full" show-on-truncate-only>
            <template #title>{{ summary(record) }}</template>
            {{ summary(record) }}
          </NcTooltip>
          <GeneralIcon v-else-if="column.key === 'actions'" icon="arrowRight" class="h-4 w-4 text-nc-content-gray-muted" />
        </template>
      </NcTable>

      <div class="flex items-center justify-end gap-3 pt-3" data-testid="nc-audit-pagination">
        <span class="text-nc-content-gray-muted text-small">{{ $t('auditLog.rowsPerPage') }}</span>
        <NcSelect v-model:value="limit" class="!w-20" size="small">
          <a-select-option v-for="n of PAGE_SIZE_OPTIONS" :key="n" :value="n">{{ n }}</a-select-option>
        </NcSelect>
        <span class="text-nc-content-gray-muted text-small">{{ $t('auditLog.page', { page: pageIndex + 1 }) }}</span>
        <NcButton
          size="small"
          type="secondary"
          :disabled="pageIndex === 0 || isLoading"
          data-testid="nc-audit-prev"
          @click="goPrevious"
        >
          {{ $t('auditLog.previousPage') }}
        </NcButton>
        <NcButton size="small" type="secondary" :disabled="!nextCursor || isLoading" data-testid="nc-audit-next" @click="goNext">
          {{ $t('auditLog.nextPage') }}
        </NcButton>
      </div>
    </div>

    <NcModal v-model:visible="isDetailOpen" size="large" :show-separator="false" wrap-class-name="nc-audit-detail-modal">
      <div
        v-if="selected"
        class="p-6 flex flex-col gap-4 max-h-[80vh] overflow-y-auto nc-scrollbar-thin"
        data-testid="nc-audit-detail"
      >
        <div class="flex items-center justify-between">
          <div class="text-lg font-bold text-nc-content-gray-emphasis">{{ $t('auditLog.details') }}</div>
          <NcButton type="text" size="small" @click="selected = null"><GeneralIcon icon="close" /></NcButton>
        </div>

        <dl class="grid grid-cols-[120px_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-nc-content-gray-muted">{{ $t('auditLog.time') }}</dt>
          <dd>{{ formatTime(selected.created_at) }}</dd>
          <dt class="text-nc-content-gray-muted">{{ $t('auditLog.user') }}</dt>
          <dd>{{ selected.user || '—' }}</dd>
          <dt class="text-nc-content-gray-muted">{{ $t('auditLog.ip') }}</dt>
          <dd>{{ selected.ip || '—' }}</dd>
          <dt class="text-nc-content-gray-muted">{{ $t('auditLog.base') }}</dt>
          <dd>{{ selected.base_title || selected.base_id || '—' }}</dd>
          <dt class="text-nc-content-gray-muted">{{ $t('auditLog.table') }}</dt>
          <dd>{{ selected.table_title || selected.fk_model_id || '—' }}</dd>
          <dt class="text-nc-content-gray-muted">{{ $t('auditLog.operation') }}</dt>
          <dd class="capitalize">{{ opLabel(selected).toLowerCase() }}</dd>
          <template v-if="selected.row_id">
            <dt class="text-nc-content-gray-muted">{{ $t('auditLog.record') }}</dt>
            <dd class="flex items-center gap-2">
              <span class="font-mono">{{ selected.row_id }}</span>
              <nuxt-link v-if="recordLink(selected)" :to="recordLink(selected)" data-testid="nc-audit-open-record">
                {{ $t('auditLog.openRecord') }}
              </nuxt-link>
            </dd>
          </template>
          <dt class="text-nc-content-gray-muted">{{ $t('general.description') }}</dt>
          <dd class="whitespace-pre-wrap break-words">{{ selected.description || '—' }}</dd>
        </dl>

        <div v-if="parsedDetails?.truncated" class="text-nc-content-gray-muted">{{ $t('auditLog.truncated') }}</div>
        <div v-else-if="changes.length">
          <div class="font-semibold mb-2">{{ $t('auditLog.changes') }}</div>
          <table class="w-full text-sm border-collapse">
            <thead>
              <tr class="text-left text-nc-content-gray-muted">
                <th class="py-1 pr-3 w-1/4">{{ $t('auditLog.field') }}</th>
                <th class="py-1 pr-3">{{ $t('auditLog.before') }}</th>
                <th class="py-1">{{ $t('auditLog.after') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c of changes" :key="c.field" class="border-t border-nc-border-gray-light align-top">
                <td class="py-1 pr-3 font-medium break-words">{{ c.field }}</td>
                <td class="py-1 pr-3 break-all text-nc-content-red-medium">{{ show(c.before) }}</td>
                <td class="py-1 break-all text-nc-content-green-medium">{{ show(c.after) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else-if="parsedDetails">
          <div class="font-semibold mb-2">{{ $t('auditLog.rawDetails') }}</div>
          <pre class="text-xs bg-nc-bg-gray-extralight rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">{{
            JSON.stringify(parsedDetails, null, 2)
          }}</pre>
        </div>
        <div v-else class="text-nc-content-gray-muted">{{ $t('auditLog.noChanges') }}</div>
      </div>
    </NcModal>
  </div>
</template>
