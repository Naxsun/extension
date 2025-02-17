import Transport from "@ledgerhq/hw-transport"
import TransportWebUSB from "@ledgerhq/hw-transport-webusb"
import Eth from "@ledgerhq/hw-app-eth"
import eip55 from "eip55"
import { DeviceModelId } from "@ledgerhq/devices"
import {
  serialize,
  UnsignedTransaction,
  parse as parseRawTransaction,
} from "@ethersproject/transactions"
import { TypedDataUtils } from "eth-sig-util"
import { bufferToHex } from "ethereumjs-util"
import { EIP1559TransactionRequest, SignedEVMTransaction } from "../../networks"
import { EIP712TypedData, HexString } from "../../types"
import BaseService from "../base"
import { ServiceCreatorFunction, ServiceLifecycleEvents } from "../types"
import logger from "../../lib/logger"
import { getOrCreateDB, LedgerDatabase } from "./db"
import { ethersTransactionRequestFromEIP1559TransactionRequest } from "../chain/utils"
import { ETH } from "../../constants"
import { getEthereumNetwork } from "../../lib/utils"

enum LedgerType {
  UNKNOWN,
  LEDGER_NANO_S,
  LEDGER_NANO_X,
}

const LedgerTypeAsString = Object.values(LedgerType)

const LedgerProductDatabase = {
  LEDGER_NANO_S: { knownPids: [0x1015] },
  LEDGER_NANO_X: { knownPids: [0x4015] },
}

const TestedProductId = (productId: number): boolean => {
  return Object.values(LedgerProductDatabase).some((e) =>
    e.knownPids.includes(productId)
  )
}

type MetaData = {
  ethereumVersion: string
}

type Events = ServiceLifecycleEvents & {
  ledgerAdded: {
    id: string
    type: LedgerType
    accountIDs: string[]
    metadata: MetaData
  }
  ledgerAccountAdded: {
    id: string
    ledgerID: string
    derivationPath: string
    addresses: HexString[]
  }
  connected: { id: string; type: LedgerType }
  disconnected: { id: string; type: LedgerType }
  address: { ledgerID: string; derivationPath: string; address: HexString }
  signedTransaction: SignedEVMTransaction
  signedData: string
}

export const idDerviationPath = "44'/60'/0'/0/0"

async function deriveAddressOnLedger(path: string, eth: Eth) {
  const derivedIdentifiers = await eth.getAddress(path)
  const address = eip55.encode(derivedIdentifiers.address)
  return address
}

async function generateLedgerId(
  transport: Transport,
  eth: Eth
): Promise<[string | undefined, LedgerType]> {
  let extensionDeviceType = LedgerType.UNKNOWN

  if (!transport.deviceModel) {
    throw new Error("Missing device model descriptor!")
  }

  switch (transport.deviceModel.id) {
    case DeviceModelId.nanoS:
      extensionDeviceType = LedgerType.LEDGER_NANO_S
      break
    case DeviceModelId.nanoX:
      extensionDeviceType = LedgerType.LEDGER_NANO_X
      break
    default:
      extensionDeviceType = LedgerType.UNKNOWN
  }

  if (extensionDeviceType === LedgerType.UNKNOWN) {
    return [undefined, extensionDeviceType]
  }

  const address = await deriveAddressOnLedger(idDerviationPath, eth)

  return [address, extensionDeviceType]
}

function signatureToString(signature: {
  v: number
  s: string
  r: string
}): string {
  let v: string | number = signature.v - 27
  v = v.toString(16)

  if (v.length < 2) {
    v = `0${v}`
  }

  return `0x${signature.r}${signature.s}${v}`
}

/**
 * The LedgerService is responsible for maintaining the connection
 * with a Ledger device.
 *
 * The main purpose for this service is to keep track of all previously
 * connected Ledgers' derived identifiers and make show an unified interface
 * to the most common operation (ie. signing)
 * - xxx
 */
export default class LedgerService extends BaseService<Events> {
  #currentLedgerId: string | undefined = undefined

  transport: Transport | undefined = undefined

  static create: ServiceCreatorFunction<Events, LedgerService, []> =
    async () => {
      return new this(await getOrCreateDB())
    }

  private constructor(private db: LedgerDatabase) {
    super()
  }

  async onConnection(productId: number): Promise<void> {
    if (!TestedProductId(productId)) {
      return
    }

    this.transport = await TransportWebUSB.create()

    const eth = new Eth(this.transport)

    const [id, type] = await generateLedgerId(this.transport, eth)

    const ethVersion = (await eth.getAppConfiguration()).version

    this.#currentLedgerId = `${LedgerTypeAsString[type]}_${id}`

    this.emitter.emit("connected", { id: this.#currentLedgerId, type })

    const knownAddresses = await this.db.getAllAccountsByLedgerId(
      this.#currentLedgerId
    )

    if (!knownAddresses.length) {
      this.emitter.emit("ledgerAdded", {
        id: this.#currentLedgerId,
        type,
        accountIDs: [idDerviationPath],
        metadata: { ethereumVersion: ethVersion },
      })
    }
  }

  async #onUSBConnect(event: USBConnectionEvent): Promise<void> {
    if (!TestedProductId(event.device.productId)) {
      return
    }

    this.onConnection(event.device.productId)
  }

  async #onUSBDisconnect(event: USBConnectionEvent): Promise<void> {
    if (!this.#currentLedgerId) {
      return
    }

    this.emitter.emit("disconnected", {
      id: this.#currentLedgerId,
      type: LedgerType.LEDGER_NANO_S,
    })

    this.#currentLedgerId = undefined
  }

  protected async internalStartService(): Promise<void> {
    await super.internalStartService() // Not needed, but better to stick to the patterns

    navigator.usb.addEventListener("connect", this.#onUSBConnect)
    navigator.usb.addEventListener("disconnect", this.#onUSBDisconnect)
  }

  protected async internalStopService(): Promise<void> {
    await super.internalStartService() // Not needed, but better to stick to the patterns

    navigator.usb.removeEventListener("disconnect", this.#onUSBDisconnect)
    navigator.usb.removeEventListener("connect", this.#onUSBConnect)
  }

  async connectLedger(): Promise<string> {
    const devArray = await navigator.usb.getDevices()

    if (devArray.length === 0) {
      throw new Error("No paired device when the Ledger is connected!?")
    }

    this.onConnection(devArray[0].productId)

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.#currentLedgerId!
  }

  async deriveAddress(accountID: string): Promise<HexString> {
    try {
      if (!this.transport) {
        throw new Error("Uninitialized transport!")
      }

      if (!this.#currentLedgerId) {
        throw new Error("Uninitialized Ledger ID!")
      }

      const eth = new Eth(this.transport)

      const accountAddress = await deriveAddressOnLedger(accountID, eth)

      this.emitter.emit("address", {
        ledgerID: this.#currentLedgerId,
        derivationPath: accountID,
        address: accountAddress,
      })

      return accountAddress
    } catch (err) {
      logger.error(
        `Error encountered! ledgerID: ${
          this.#currentLedgerId
        } accountID: ${accountID} error: ${err}`
      )
    }

    throw new Error("Address derivation is unsuccessful!")
  }

  async saveAddress(path: HexString, address: string): Promise<void> {
    if (!this.#currentLedgerId) {
      throw new Error("No Ledger id is set!")
    }

    await this.db.addAccount({ ledgerId: this.#currentLedgerId, path, address })
  }

  async signTransaction(
    address: HexString,
    transactionRequest: EIP1559TransactionRequest & { nonce: number }
  ): Promise<SignedEVMTransaction> {
    try {
      if (!this.transport) {
        throw new Error("Uninitialized transport!")
      }

      if (!this.#currentLedgerId) {
        throw new Error("Uninitialized Ledger ID!")
      }

      const ethersTx =
        ethersTransactionRequestFromEIP1559TransactionRequest(
          transactionRequest
        )

      const serializedTx = serialize(ethersTx as UnsignedTransaction).substring(
        2
      ) // serialize adds 0x prefix which kills Eth::signTransaction

      const accountData = await this.db.getAccountByAddress(address)
      if (!accountData) {
        throw new Error(
          "Cannot generate signature without stored derivation path!"
        )
      }

      const eth = new Eth(this.transport)
      const signature = await eth.signTransaction(
        accountData.path,
        serializedTx,
        null
      )

      const alteredSig = {
        r: signature.r,
        s: signature.s,
        v: parseInt(signature.v, 16),
      }

      const signedTransaction = serialize(
        ethersTx as UnsignedTransaction,
        alteredSig
      )
      const tx = parseRawTransaction(signedTransaction)

      if (
        !tx.hash ||
        !tx.from ||
        !tx.r ||
        !tx.s ||
        typeof tx.v === "undefined"
      ) {
        throw new Error("Transaction doesn't appear to have been signed.")
      }

      if (
        typeof tx.maxPriorityFeePerGas === "undefined" ||
        typeof tx.maxFeePerGas === "undefined" ||
        tx.type !== 2
      ) {
        throw new Error("Can only sign EIP-1559 conforming transactions")
      }

      const signedTx: SignedEVMTransaction = {
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        nonce: tx.nonce,
        input: tx.data,
        value: tx.value.toBigInt(),
        type: tx.type,
        gasPrice: null,
        maxFeePerGas: tx.maxFeePerGas.toBigInt(),
        maxPriorityFeePerGas: tx.maxPriorityFeePerGas.toBigInt(),
        gasLimit: tx.gasLimit.toBigInt(),
        r: tx.r,
        s: tx.s,
        v: tx.v,

        blockHash: null,
        blockHeight: null,
        asset: ETH,
        network: getEthereumNetwork(),
      }

      return signedTx
    } catch (err) {
      logger.error(
        `Error encountered! ledgerID: ${
          this.#currentLedgerId
        } address: ${address} transactionRequest: ${transactionRequest} error: ${err}`
      )
    }

    throw new Error("Transaction signing is unsuccessful!")
  }

  async signTypedData(
    typedData: EIP712TypedData,
    account: HexString
  ): Promise<string> {
    try {
      if (!this.transport) {
        throw new Error("Uninitialized transport!")
      }

      if (!this.#currentLedgerId) {
        throw new Error("Uninitialized Ledger ID!")
      }

      const eth = new Eth(this.transport)
      const hashedDomain = TypedDataUtils.hashStruct(
        "EIP712Domain",
        typedData.domain,
        typedData.types,
        true
      )
      const hashedMessage = TypedDataUtils.hashStruct(
        typedData.primaryType,
        typedData.message,
        typedData.types,
        true
      )

      const signature = await eth.signEIP712HashedMessage(
        account,
        bufferToHex(hashedDomain),
        bufferToHex(hashedMessage)
      )
      this.emitter.emit("signedData", signatureToString(signature))
      return signatureToString(signature)
    } catch (error) {
      throw new Error("Signing data failed")
    }

    throw new Error("Typed data signing is unsuccessful!")
  }

  async signMessage(address: string, message: string): Promise<string> {
    try {
      if (!this.transport) {
        throw new Error("Uninitialized transport!")
      }

      if (!this.#currentLedgerId) {
        throw new Error("Uninitialized Ledger ID!")
      }

      const eth = new Eth(this.transport)

      const signature = await eth.signPersonalMessage(address, message)
      this.emitter.emit("signedData", signatureToString(signature))
      return signatureToString(signature)
    } catch (error) {
      throw new Error("Signing data failed")
    }

    throw new Error("Typed data signing is unsuccessful!")
  }
}
