import { useReducerActions } from '@dusanjovanov/use-reducer-actions';
import * as React from 'react';

export const useEffectOnce = (effect: () => void | (() => void)) => {
  const effectFn = React.useRef<() => void | (() => void)>(effect);
  const destroyFn = React.useRef<void | (() => void)>();
  const effectCalled = React.useRef(false);
  const rendered = React.useRef(false);
  const [, setVal] = React.useState<number>(0);

  if (effectCalled.current) {
    rendered.current = true;
  }

  React.useEffect(() => {
    // only execute the effect first time around
    if (!effectCalled.current) {
      destroyFn.current = effectFn.current();
      effectCalled.current = true;
    }

    // this forces one render after the effect is run
    setVal(val => val + 1);

    return () => {
      // if the comp didn't render since the useEffect was called,
      // we know it's the dummy React cycle
      if (!rendered.current) {
        return;
      }

      // otherwise this is not a dummy destroy, so call the destroy func
      if (destroyFn.current) {
        destroyFn.current();
      }
    };
  }, []);
};

type Awaited<T> = T extends Promise<infer U> ? U : T;

type QueriesGeneric = {
  [name: string]: {
    /** A function whose responsibility is to make the network request for the query.
     *
     * Should return a Promise with the data, or throw an Error in case of one.
     */
    fn: (arg: any) => Promise<any>;
    /**
     * Time in ms for how long the cached data for the query should remain in state after no component is using it.
     * (after all the components which call `useQuery` with this queries key have unmounted.)
     */
    cacheTime?: number;
    /**
     * Time in ms before the data for this query is considered stale. (ie. a new component mounts and subscribes
     * to this query, and if the data is stale, the request will be made, otherwise it won't)
     */
    staleTime?: number;
    /**
     * The query fn won't be executed if this is false. Use case for this is when the query depends on some arg
     * and the arg is not available yet (undefined | null)
     */
    isEnabled?: boolean;
    /**
     * Data to be returned before data from the server is available
     */
    initialData?: any;
  };
};

type MutationsGeneric = {
  [name: string]: {
    /**
     * A function whose responsibility is to make the network request for the mutation (usually POST, PUT, PATCH, DELETE).
     *
     * Should return a Promise with or without a result from the server, or throw an Error in case of one.
     */
    fn: (arg: any) => Promise<any>;
  };
};

type GetArgType<Fn> = Fn extends () => Promise<any>
  ? undefined
  : Fn extends (arg: infer Arg) => Promise<any>
  ? Arg
  : unknown;

type RefCache = {
  [cacheKey: string]: {
    isFetching: boolean;
    successTime: number | null;
    errorTime: number | null;
    deleteCacheTimeout: NodeJS.Timeout | null;
    subscribers: {
      [id: string]: {};
    };
  };
};

type RefSubscribers = {
  [id: string]: {
    cacheKey: string;
  };
};

type SetQueryData<Queries extends QueriesGeneric> = <
  QueryName extends keyof Queries
>(args: {
  queryName: QueryName;
  reducer: (
    data: QueryData<Queries[QueryName]>
  ) => Awaited<ReturnType<Queries[QueryName]['fn']>>;
  arg?: Parameters<Queries[QueryName]['fn']>[0];
}) => void;

type MutationOptions<
  Mutation extends MutationsGeneric[string],
  Queries extends QueriesGeneric
> = {
  onMutate: (
    arg: GetArgType<Mutation['fn']>,
    utils: {
      setQueryData: SetQueryData<Queries>;
    }
  ) => void;
};

enum QueryStatus {
  idle,
  loading,
  success,
  error,
}

enum MutationStatus {
  idle,
  loading,
  success,
  error,
}

type QueryState<Query extends QueriesGeneric[string]> = {
  [cacheKey: string]: CacheKeyState<Query>;
};

type CacheKeyState<Query extends QueriesGeneric[string]> = {
  data: QueryData<Query>;
  status: QueryStatus;
  isFetching: boolean;
  error: Error | null;
};

type MutationState<Mutation extends MutationsGeneric[string]> = {
  data: Awaited<ReturnType<Mutation['fn']>>;
  status: MutationStatus;
  error: Error | null;
};

type QueryOptions<Query extends QueriesGeneric[string]> = {
  arg?: GetArgType<Query['fn']> | skipToken;
  isEnabled?: boolean;
};

type ApiProviderQueryState<Queries extends QueriesGeneric> = {
  [QueryName in keyof Queries]: QueryState<Queries[QueryName]>;
};

type ApiProviderMutationState<Mutations extends MutationsGeneric> = {
  [MutationName in keyof Mutations]: {
    [id: string]: MutationState<Mutations[MutationName]>;
  };
};

type QueryData<Query extends QueriesGeneric[string]> = Awaited<
  ReturnType<Query['fn']>
>;

type MutationData<Mutation extends MutationsGeneric[string]> = Awaited<
  ReturnType<Mutation['fn']>
>;

type InternalContextValue = {
  mountOrChangeArg: (args: {
    queryName: string;
    arg: any;
    cacheKey: string;
    id: string;
    isEnabled?: boolean;
  }) => void;
  unsubscribe: (args: {
    queryName: string;
    cacheKey: string;
    id: string;
  }) => void;
  makeQueryRequest: (args: {
    queryName: string;
    cacheKey: string;
    arg: any;
  }) => Promise<any>;
  queryActions: any;
  mutationActions: any;
};

type UseQueryReturn<Query extends QueriesGeneric[string]> = {
  data: QueryData<Query> | undefined;
  status: QueryStatus;
  isFetching: boolean;
  isLoading: boolean;
  isIdle: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
};

type MutateFn<Mutation extends MutationsGeneric[string]> = (
  arg: GetArgType<Mutation['fn']>
) => Promise<MutationData<Mutation>>;

const logger = {
  outsideProvider: (what: string, name: string) =>
    console.error(
      `[react-papi] You called ${what}(${name}) outside of Provider`
    ),
  unknownName: (what: string, type: string, name: string) =>
    console.error(
      `[react-papi] You called ${what} with an unknown ${type} name: ${name}`
    ),
} as const;

function createCacheKey(queryName: string, arg: any) {
  return `${queryName}(${arg === undefined ? '' : JSON.stringify(arg)})`;
}

function getQueryReturn<Query extends QueriesGeneric[string]>({
  cacheKeyState,
  query,
  makeQueryRequest,
  queryName,
  cacheKey,
  arg,
}: {
  cacheKeyState: CacheKeyState<Query>;
  query: Query;
  makeQueryRequest: InternalContextValue['makeQueryRequest'];
  queryName: string;
  arg: any;
  cacheKey: string;
}): UseQueryReturn<Query> {
  return {
    data: cacheKeyState?.data ?? query.initialData,
    status: cacheKeyState?.status ?? QueryStatus.idle,
    isFetching: cacheKeyState?.isFetching ?? false,
    isLoading: cacheKeyState?.status === QueryStatus.loading,
    isIdle: cacheKeyState?.status === QueryStatus.idle,
    isError: cacheKeyState?.status === QueryStatus.error,
    error: cacheKeyState?.error ?? null,
    refetch: () =>
      makeQueryRequest({ queryName: String(queryName), arg, cacheKey }),
  };
}

function getMutationReturn<Mutation extends MutationsGeneric[string]>({
  state,
  mutate,
}: {
  state: MutationState<Mutation>;
  mutate: MutateFn<Mutation>;
}) {
  return {
    mutate,
    status: state?.status ?? MutationStatus.idle,
    isIdle: state?.status === MutationStatus.idle,
    isLoading: state?.status === MutationStatus.loading,
    isSuccess: state?.status === MutationStatus.success,
    isError: state?.status === MutationStatus.error,
    data: state?.data,
    error: state?.error ?? null,
  };
}

const defaultCacheTime = 60 * 1000;
const defaultStaleTime = 60 * 1000;

export function createApi<
  Queries extends QueriesGeneric,
  Mutations extends MutationsGeneric
>({
  queries = {} as Queries,
  mutations = {} as Mutations,
}: {
  queries?: Queries;
  mutations?: Mutations;
}) {
  const queryConfig = {} as any;
  const mutationConfig = {} as any;
  const initialQueryState = {} as any;
  const initialMutationState = {} as any;
  for (const name of Object.keys(queries)) {
    const context = React.createContext({} as any);
    context.displayName = name;
    queryConfig[name] = context;
    initialQueryState[name] = {};
  }
  for (const name of Object.keys(mutations)) {
    const context = React.createContext({} as any);
    context.displayName = name;
    mutationConfig[name] = context;
    initialMutationState[name] = {};
  }
  const internalContext = React.createContext({} as InternalContextValue);
  internalContext.displayName = 'InternalQuery';

  const ApiProvider = ({ children }: { children: React.ReactNode }) => {
    const [queryState, queryActions] = useReducerActions({
      initialState: initialQueryState as ApiProviderQueryState<Queries>,
      reducers: {
        start: (state, payload: { queryName: string; cacheKey: string }) => {
          const newCacheState: any = {
            ...(state[payload.queryName][payload.cacheKey] ?? {}),
            isFetching: true,
          };
          if (newCacheState.data === undefined) {
            newCacheState.status = 'loading';
          }
          return {
            ...state,
            [payload.queryName]: {
              ...state[payload.queryName],
              [payload.cacheKey]: newCacheState,
            },
          };
        },
        succes: (
          state,
          payload: { queryName: string; cacheKey: string; data: any }
        ) => {
          return {
            ...state,
            [payload.queryName]: {
              ...state[payload.queryName],
              [payload.cacheKey]: {
                ...state[payload.cacheKey],
                status: 'success',
                isFetching: false,
                data: payload.data,
              },
            },
          };
        },
        error: (
          state,
          payload: { queryName: string; cacheKey: string; error: Error }
        ) => {
          return {
            ...state,
            [payload.queryName]: {
              ...state[payload.queryName],
              [payload.cacheKey]: {
                ...state[payload.cacheKey],
                status: 'error',
                isFetching: false,
                error: payload.error,
              },
            },
          };
        },
        deleteCache: (
          state,
          payload: { queryName: string; cacheKey: string }
        ) => {
          delete state[payload.queryName][payload.cacheKey];
          return state;
        },
        setQueryData: (
          state,
          payload: {
            queryName: string;
            reducer: (cacheState: any) => any;
            arg: any;
          }
        ) => {
          const cacheKey = createCacheKey(
            payload.queryName,
            JSON.stringify(payload.arg)
          );
          return {
            ...state,
            [payload.queryName]: {
              ...state[payload.queryName],
              [cacheKey]: {
                ...state[payload.queryName][cacheKey],
                data: payload.reducer(state[payload.queryName][cacheKey].data),
              },
            },
          };
        },
      },
    });

    const [mutationState, mutationActions] = useReducerActions({
      initialState: initialMutationState as ApiProviderMutationState<Mutations>,
      reducers: {
        start: (state, payload: { mutationName: string; id: string }) => {
          return {
            ...state,
            [payload.mutationName]: {
              ...state[payload.mutationName],
              [payload.id]: {
                status: 'loading',
              },
            },
          };
        },
        success: (
          state,
          payload: { mutationName: string; id: string; data: any }
        ) => {
          return {
            ...state,
            [payload.mutationName]: {
              ...state[payload.mutationName],
              [payload.id]: {
                status: 'success',
                data: payload.data,
              },
            },
          };
        },
        error: (
          state,
          payload: { mutationName: string; id: string; error: Error }
        ) => {
          return {
            ...state,
            [payload.mutationName]: {
              ...state[payload.mutationName],
              [payload.id]: {
                status: 'error',
                error: payload.error,
              },
            },
          };
        },
      },
    });

    const refCache = React.useRef<RefCache>({});
    const refSubscribers = React.useRef<RefSubscribers>({});

    const makeQueryRequest = React.useCallback<
      InternalContextValue['makeQueryRequest']
    >(
      async ({ queryName, cacheKey, arg }) => {
        queryActions.start({ queryName, cacheKey });
        refCache.current[cacheKey].isFetching = true;
        try {
          const data = await queries[queryName].fn(arg);
          queryActions.succes({ queryName, cacheKey, data });
          refCache.current[cacheKey].isFetching = false;
          refCache.current[cacheKey].successTime = Date.now();
        } catch (error) {
          queryActions.error({ queryName, cacheKey, error: error as any });
          refCache.current[cacheKey].isFetching = false;
          refCache.current[cacheKey].errorTime = Date.now();
        }
      },
      [queryActions]
    );

    const initializeRefCacheKey = React.useCallback((cacheKey: string) => {
      refCache.current[cacheKey] = {
        isFetching: false,
        successTime: null,
        errorTime: null,
        deleteCacheTimeout: null,
        subscribers: {},
      };
    }, []);

    const handleCacheDeletion = React.useCallback(
      (queryName: string, cacheKey: string) => {
        const numberOfSubs = Object.keys(refCache.current[cacheKey].subscribers)
          .length;
        if (numberOfSubs === 0) {
          const timeout = setTimeout(() => {
            queryActions.deleteCache({ queryName, cacheKey });
            delete refCache.current[cacheKey];
          }, queries[queryName].cacheTime ?? defaultCacheTime);
          refCache.current[cacheKey].deleteCacheTimeout = timeout;
        }
      },
      [queryActions]
    );

    const subscribe = React.useCallback(
      ({
        queryName,
        arg,
        cacheKey,
        id,
        isEnabled = true,
      }: {
        queryName: string;
        arg: any;
        cacheKey: string;
        id: string;
        isEnabled?: boolean;
      }) => {
        refSubscribers.current[id] = {
          cacheKey,
        };
        refCache.current[cacheKey].subscribers[id] = true;

        let shouldMakeRequest = false;

        // first check if the useQuery is enabled
        if (isEnabled && arg !== skipToken) {
          // data doesn't exist in cache
          if (refCache.current[cacheKey].successTime === null) {
            shouldMakeRequest = true;
          } else {
            const staleTime = queries[queryName].staleTime ?? defaultStaleTime;
            // cache is stale
            if (
              staleTime === 0 ||
              Date.now() - refCache.current[cacheKey].successTime! > staleTime
            ) {
              shouldMakeRequest = true;
            }
          }
        }
        if (shouldMakeRequest) {
          makeQueryRequest({ queryName, cacheKey, arg });
        }
        // don't delete cache - there's a new subscriber
        if (refCache.current[cacheKey].deleteCacheTimeout !== null) {
          clearTimeout(refCache.current[cacheKey].deleteCacheTimeout!);
        }
      },
      [makeQueryRequest]
    );

    const mountOrChangeArg = React.useCallback<
      InternalContextValue['mountOrChangeArg']
    >(
      ({ queryName, cacheKey, id, arg, isEnabled }) => {
        // cache object for cacheKey doesn't exist
        if (refCache.current[cacheKey] === undefined) {
          initializeRefCacheKey(cacheKey);
        }
        // not subscribed yet
        if (refSubscribers.current[id] === undefined) {
          subscribe({ queryName, arg, cacheKey, id, isEnabled });
        }
        // subscribed
        else {
          // cacheKey changed for subscriber (queryName or arg - probably arg)
          const oldCacheKey = refSubscribers.current[id].cacheKey;
          if (cacheKey !== oldCacheKey) {
            subscribe({ queryName, arg, cacheKey, id, isEnabled });
            delete refCache.current[oldCacheKey].subscribers[id];
            handleCacheDeletion(queryName, oldCacheKey);
          }
        }
      },
      [initializeRefCacheKey, handleCacheDeletion, subscribe]
    );

    const unsubscribe = React.useCallback<InternalContextValue['unsubscribe']>(
      ({ queryName, cacheKey, id }) => {
        delete refSubscribers.current[id];
        delete refCache.current[cacheKey].subscribers[id];
        handleCacheDeletion(queryName, cacheKey);
      },
      [handleCacheDeletion]
    );

    const internalCtxValue = React.useMemo(() => {
      return {
        mountOrChangeArg,
        unsubscribe,
        makeQueryRequest,
        queryActions,
        mutationActions,
      };
    }, [
      mountOrChangeArg,
      unsubscribe,
      makeQueryRequest,
      queryActions,
      mutationActions,
    ]);

    function buildProviderTree(
      children: React.ReactNode,
      config: any,
      state: any
    ) {
      let tree = children;
      const entries = Object.entries<any>(config);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [name, context] = entries[i];
        tree = React.createElement(
          context.Provider,
          {
            value: state[name],
          },
          tree
        );
      }
      return tree;
    }

    return (
      <internalContext.Provider value={internalCtxValue}>
        {buildProviderTree(
          buildProviderTree(children, mutationConfig, mutationState),
          queryConfig,
          queryState
        )}
      </internalContext.Provider>
    );
  };

  function useQuery<QueryName extends keyof Queries>(
    queryName: QueryName,
    options?: QueryOptions<Queries[QueryName]>
  ) {
    const ctx = React.useContext<QueryState<Queries[QueryName]>>(
      queryConfig[queryName]
    );
    if (ctx === undefined)
      logger.outsideProvider('useQuery', String(queryName));
    if (!(queryName in queryConfig))
      logger.unknownName('useQuery', 'query', String(queryName));

    const { arg, isEnabled } = options ?? {};

    const cacheKey = createCacheKey(String(queryName), arg);

    const {
      mountOrChangeArg,
      unsubscribe,
      makeQueryRequest,
    } = React.useContext(internalContext);

    const id = React.useId();

    React.useEffect(() => {
      mountOrChangeArg({
        queryName: String(queryName),
        arg,
        cacheKey,
        id,
        isEnabled,
      });
    }, [arg, cacheKey, queryName, mountOrChangeArg, isEnabled, id]);

    // useEffectOnce ensures unsubscribe is run only when component is actually unmounted
    useEffectOnce(() => () =>
      unsubscribe({
        queryName: String(queryName),
        cacheKey,
        id,
      })
    );

    return getQueryReturn({
      queryName: String(queryName),
      arg,
      cacheKey,
      cacheKeyState: ctx[cacheKey],
      makeQueryRequest,
      query: queries[queryName],
    });
  }

  function useMutation<MutationName extends keyof Mutations>(
    mutationName: MutationName,
    options?: MutationOptions<Mutations[MutationName], Queries>
  ) {
    const ctx = React.useContext(mutationConfig[mutationName]) as any;
    if (ctx === undefined)
      logger.outsideProvider('useMutation', String(mutationName));
    if (!(mutationName in mutationConfig))
      logger.unknownName('useMutation', 'mutation', String(mutationName));

    const id = React.useId();

    const state = ctx[id];

    const { mutationActions, queryActions } = React.useContext(internalContext);

    const { onMutate } = options ?? { onMutate: () => {} };

    const mutate: MutateFn<Mutations[MutationName]> = async arg => {
      onMutate(arg, { setQueryData: queryActions.setQueryData });
      mutationActions.start({ mutationName, id });
      try {
        const data = await mutations[mutationName].fn(arg);
        mutationActions.success({ mutationName, id, data });
        return data;
      } catch (error) {
        mutationActions.error({ mutationName, id, error });
      }
    };

    return getMutationReturn({ state, mutate });
  }

  return {
    ApiProvider,
    useQuery,
    useMutation,
  };
}

export const skipToken = Symbol.for('goodboy-skipToken');
// eslint-disable-next-line @typescript-eslint/no-redeclare
export type skipToken = typeof skipToken;
