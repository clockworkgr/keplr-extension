import { delay, inject, singleton } from "tsyringe";
import { TYPES } from "../types";

import { InteractionService } from "../interaction";
import { Env } from "@keplr-wallet/router";
import {
  getBasicAccessPermissionType,
  INTERACTION_TYPE_PERMISSION,
  INTERACTION_TYPE_MULTI_PERMISSION,
  PermissionData,
  MultiplePermissionData,
} from "./types";
import { KVStore } from "@keplr-wallet/common";
import { ChainsService } from "../chains";
import { KeyRingService } from "../keyring";
import { ChainIdHelper } from "@keplr-wallet/cosmos";

@singleton()
export class PermissionService {
  protected permissionMap: {
    [chainIdentifier: string]:
      | {
          [type: string]:
            | {
                [origin: string]: true | undefined;
              }
            | undefined;
        }
      | undefined;
  } = {};

  protected privilegedOrigins: Map<string, boolean> = new Map();

  constructor(
    @inject(TYPES.PermissionStore)
    protected readonly kvStore: KVStore,
    @inject(delay(() => InteractionService))
    protected readonly interactionService: InteractionService,
    @inject(ChainsService)
    protected readonly chainsService: ChainsService,
    @inject(delay(() => KeyRingService))
    protected readonly keyRingService: KeyRingService,
    @inject(TYPES.PermissionServicePrivilegedOrigins)
    privilegedOrigins: string[]
  ) {
    for (const origin of privilegedOrigins) {
      this.privilegedOrigins.set(origin, true);
    }

    this.restore();

    this.chainsService.addChainRemovedHandler(this.onChainRemoved);
  }

  protected readonly onChainRemoved = (chainId: string) => {
    this.removeAllPermissions(chainId);
  };

  async checkOrGrantBasicAccessPermission(
    env: Env,
    chainId: string,
    origin: string
  ) {
    // Try to unlock the key ring before checking or granting the basic permission.
    await this.keyRingService.enable(env);

    if (!this.hasPermisson(chainId, getBasicAccessPermissionType(), origin)) {
      await this.grantBasicAccessPermission(env, chainId, [origin]);
    }

    await this.checkBasicAccessPermission(env, chainId, origin);
  }

  async checkOrGrantMultipleAccessPermission(
    env: Env,
    chainIds: string[],
    origin: string
  ) {
    // Try to unlock the key ring before checking or granting the basic permission.
    await this.keyRingService.enable(env);
    const chainsToPermit: string[] = [];
    for (const chainId of chainIds) {
      if (!this.hasPermisson(chainId, getBasicAccessPermissionType(), origin)) {
        chainsToPermit.push(chainId);
      }
    }
    if (chainsToPermit.length > 0) {
      await this.grantMultipleAccessPermission(env, chainsToPermit, [origin]);
    }
    for (const chainId of chainIds) {
      await this.checkBasicAccessPermission(env, chainId, origin);
    }
  }
  async grantPermission(
    env: Env,
    url: string,
    chainId: string,
    type: string,
    origins: string[]
  ) {
    if (env.isInternalMsg) {
      return;
    }

    const permissionData: PermissionData = {
      chainId,
      type,
      origins,
    };

    await this.interactionService.waitApprove(
      env,
      url,
      INTERACTION_TYPE_PERMISSION,
      permissionData
    );

    await this.addPermission(chainId, type, origins);
  }

  async grantMultiplePermission(
    env: Env,
    url: string,
    chainIds: string[],
    type: string,
    origins: string[]
  ) {
    if (env.isInternalMsg) {
      return;
    }

    const permissionData: MultiplePermissionData = {
      chainIds,
      type,
      origins,
    };

    await this.interactionService.waitApprove(
      env,
      url,
      INTERACTION_TYPE_MULTI_PERMISSION,
      permissionData
    );
    for (const chainId of chainIds) {
      await this.addPermission(chainId, type, origins);
    }
  }
  async grantBasicAccessPermission(
    env: Env,
    chainId: string,
    origins: string[]
  ) {
    // Make sure that the chain info is registered.
    await this.chainsService.getChainInfo(chainId);

    await this.grantPermission(
      env,
      "/access",
      chainId,
      getBasicAccessPermissionType(),
      origins
    );
  }

  async grantMultipleAccessPermission(
    env: Env,
    chainIds: string[],
    origins: string[]
  ) {
    // Make sure that the chain info is registered.
    for (const chainId of chainIds) {
      await this.chainsService.getChainInfo(chainId);
    }

    await this.grantMultiplePermission(
      env,
      "/access",
      chainIds,
      getBasicAccessPermissionType(),
      origins
    );
  }
  checkPermission(env: Env, chainId: string, type: string, origin: string) {
    if (env.isInternalMsg) {
      return;
    }

    if (!this.hasPermisson(chainId, type, origin)) {
      throw new Error(`${origin} is not permitted`);
    }
  }

  async checkBasicAccessPermission(env: Env, chainId: string, origin: string) {
    // Make sure that the chain info is registered.
    await this.chainsService.getChainInfo(chainId);

    this.checkPermission(env, chainId, getBasicAccessPermissionType(), origin);
  }

  hasPermisson(chainId: string, type: string, origin: string): boolean {
    // Privileged origin can pass the any permission.
    if (this.privilegedOrigins.get(origin)) {
      return true;
    }

    const permissionsInChain = this.permissionMap[
      ChainIdHelper.parse(chainId).identifier
    ];
    if (!permissionsInChain) {
      return false;
    }

    const innerMap = permissionsInChain[type];
    return !(!innerMap || !innerMap[origin]);
  }

  getPermissionOrigins(chainId: string, type: string): string[] {
    const origins = [];

    const permissionsInChain = this.permissionMap[
      ChainIdHelper.parse(chainId).identifier
    ];
    if (!permissionsInChain) {
      return [];
    }

    const innerMap = permissionsInChain[type];
    if (!innerMap) {
      return [];
    }

    for (const origin of Object.keys(innerMap)) {
      if (innerMap[origin]) {
        origins.push(origin);
      }
    }

    return origins;
  }

  protected async addPermission(
    chainId: string,
    type: string,
    origins: string[]
  ) {
    let permissionsInChain = this.permissionMap[
      ChainIdHelper.parse(chainId).identifier
    ];
    if (!permissionsInChain) {
      permissionsInChain = {};
      this.permissionMap[
        ChainIdHelper.parse(chainId).identifier
      ] = permissionsInChain;
    }

    let innerMap = permissionsInChain[type];
    if (!innerMap) {
      innerMap = {};
      permissionsInChain[type] = innerMap;
    }

    for (const origin of origins) {
      innerMap[origin] = true;
    }

    await this.save();
  }

  async removePermission(chainId: string, type: string, origins: string[]) {
    const permissionsInChain = this.permissionMap[
      ChainIdHelper.parse(chainId).identifier
    ];
    if (!permissionsInChain) {
      return;
    }

    const innerMap = permissionsInChain[type];
    if (!innerMap) {
      return;
    }

    for (const origin of origins) {
      delete innerMap[origin];
    }

    await this.save();
  }

  async removeAllPermissions(chainId: string) {
    this.permissionMap[ChainIdHelper.parse(chainId).identifier] = undefined;

    await this.save();
  }

  protected async restore() {
    const map = await this.kvStore.get<any>("permissionMap");
    if (map) {
      this.permissionMap = map;
    }
  }

  protected async save() {
    await this.kvStore.set("permissionMap", this.permissionMap);
  }
}
