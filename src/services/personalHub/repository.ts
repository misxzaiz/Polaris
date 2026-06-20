/**
 * 通用数据访问层（Repository Pattern）
 * 移植自 personal-hub src/services/repository.ts，将静态 supabase 单例改为 getSupabase() 按需获取。
 */
import { getSupabase } from './supabase'

export type FilterOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'like'
  | 'ilike'
  | 'in'
  | 'is'

export interface Filter {
  field: string
  operator: FilterOperator
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any
}

export interface SortOption {
  field: string
  ascending?: boolean
}

export interface QueryOptions {
  filters?: Filter[]
  sortBy?: SortOption[]
  limit?: number
  offset?: number
  select?: string
}

export interface PaginatedResult<T> {
  data: T[]
  count: number
  hasMore: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type QueryBuilder = any

export class Repository<T = any> {
  constructor(
    private tableName: string,
    private userId?: string,
  ) {}

  async findById(id: string, options?: QueryOptions): Promise<T | null> {
    let query = getSupabase()
      .from(this.tableName)
      .select(options?.select || '*')
      .eq('id', id)

    if (this.userId) {
      query = query.eq('user_id', this.userId)
    }

    const { data, error } = await query.single()
    if (error) {
      if (error.code === 'PGRST116') return null
      throw error
    }
    return data as unknown as T
  }

  async findMany(options?: QueryOptions): Promise<T[]> {
    let query = getSupabase().from(this.tableName).select(options?.select || '*')
    if (this.userId) query = query.eq('user_id', this.userId)
    query = this.applyFilters(query, options?.filters)
    if (options?.sortBy) {
      options.sortBy.forEach((sort) => {
        query = query.order(sort.field, { ascending: sort.ascending ?? false })
      })
    }
    if (options?.limit) query = query.limit(options.limit)
    if (options?.offset) {
      query = query.range(options.offset, options.offset + (options.limit || 10) - 1)
    }
    const { data, error } = await query
    if (error) throw error
    return (data || []) as unknown as T[]
  }

  async create(data: Partial<T>): Promise<T> {
    const insertData = {
      ...data,
      ...(this.userId && { user_id: this.userId }),
    }
    const { data: result, error } = await getSupabase()
      .from(this.tableName)
      .insert(insertData as never)
      .select()
      .single()
    if (error) throw error
    return result as unknown as T
  }

  async update(id: string, data: Partial<T>): Promise<T> {
    let query = getSupabase().from(this.tableName).update(data as never).eq('id', id)
    if (this.userId) query = query.eq('user_id', this.userId)
    const { data: result, error } = await query.select().single()
    if (error) throw error
    return result as unknown as T
  }

  async delete(id: string): Promise<void> {
    let query = getSupabase().from(this.tableName).delete().eq('id', id)
    if (this.userId) query = query.eq('user_id', this.userId)
    const { error } = await query
    if (error) throw error
  }

  private applyFilters(query: QueryBuilder, filters?: Filter[]): QueryBuilder {
    if (!filters || filters.length === 0) return query
    filters.forEach((filter) => {
      const { field, operator, value } = filter
      switch (operator) {
        case 'eq': query = query.eq(field, value); break
        case 'neq': query = query.neq(field, value); break
        case 'gt': query = query.gt(field, value); break
        case 'gte': query = query.gte(field, value); break
        case 'lt': query = query.lt(field, value); break
        case 'lte': query = query.lte(field, value); break
        case 'like': query = query.like(field, value); break
        case 'ilike': query = query.ilike(field, value); break
        case 'in': query = query.in(field, value); break
        case 'is': query = query.is(field, value); break
      }
    })
    return query
  }
}

/** links 表专用仓储 */
export class LinksRepository extends Repository<any> {
  constructor(userId?: string) {
    super('links', userId)
  }

  async findByType(type: string, options?: Omit<QueryOptions, 'filters'>): Promise<any[]> {
    return this.findMany({
      ...options,
      filters: [{ field: 'type', operator: 'eq', value: type }],
    })
  }
}

export function createLinksRepository(userId: string): LinksRepository {
  return new LinksRepository(userId)
}
