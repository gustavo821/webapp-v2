import { useCallback, useContext, useMemo, useState } from 'react'
import { useWalletKit } from '@gokiprotocol/walletkit'
import { useSolana, useConnectedWallet } from '@saberhq/use-solana'
import { TransactionResponse } from '@ethersproject/providers'
import { Currency, CurrencyAmount, Percent } from '@uniswap/sdk-core'
import { AlertTriangle, AlertCircle } from 'react-feather'
import ReactGA from 'react-ga'
import { ZERO_PERCENT } from '../../constants/misc'
import { NONFUNGIBLE_POSITION_MANAGER_ADDRESSES, PROGRAM_ID_STR } from '../../constants/addresses'
import {
  BITMAP_SEED,
  FEE_SEED,
  OBSERVATION_SEED,
  POOL_SEED,
  POSITION_SEED,
  SOL_LOCAL,
  TICK_SEED,
  WETH9_EXTENDED,
} from '../../constants/tokens'
import { useV3NFTPositionManagerContract } from '../../hooks/useContract'
import { RouteComponentProps } from 'react-router-dom'
import { Text } from 'rebass'
import { ThemeContext } from 'styled-components/macro'
import { ButtonError, ButtonLight, ButtonPrimary, ButtonText } from '../../components/Button'
import { YellowCard, OutlineCard, BlueCard, LightCard } from '../../components/Card'
import { AutoColumn } from '../../components/Column'
import TransactionConfirmationModal, { ConfirmationModalContent } from '../../components/TransactionConfirmationModal'
import CurrencyInputPanel from '../../components/CurrencyInputPanel'
import { RowBetween, RowFixed } from '../../components/Row'
import { useIsSwapUnsupported } from '../../hooks/useIsSwapUnsupported'
import { useUSDCValue } from '../../hooks/useUSDCPrice'
import approveAmountCalldata from '../../utils/approveAmountCalldata'
import { calculateGasMargin } from '../../utils/calculateGasMargin'
import { Review } from './Review'
import { useActiveWeb3React, useActiveWeb3ReactSol } from '../../hooks/web3'
import { useCurrency } from '../../hooks/Tokens'
import { ApprovalState, useApproveCallback } from '../../hooks/useApproveCallback'
import useTransactionDeadline from '../../hooks/useTransactionDeadline'
import { useWalletModalToggle } from '../../state/application/hooks'
import { Field, Bound } from '../../state/mint/v3/actions'
import { NetworkAlert } from 'components/NetworkAlert/NetworkAlert'
import { useTransactionAdder } from '../../state/transactions/hooks'
import { useIsExpertMode, useUserSlippageToleranceWithDefault } from '../../state/user/hooks'
import { TYPE, ExternalLink } from '../../theme'
import { maxAmountSpend } from '../../utils/maxAmountSpend'
import AppBody from '../AppBody'
import { Dots } from '../Pool/styleds'
import { currencyId } from '../../utils/currencyId'
import UnsupportedCurrencyFooter from 'components/swap/UnsupportedCurrencyFooter'
import { DynamicSection, CurrencyDropdown, StyledInput, Wrapper, ScrollablePage } from './styled'
import { Trans, t } from '@lingui/macro'
import {
  useV3MintState,
  useV3MintActionHandlers,
  useRangeHopCallbacks,
  useV3DerivedMintInfo,
} from 'state/mint/v3/hooks'
import { FeeAmount, NonfungiblePositionManager, u32ToSeed } from '@uniswap/v3-sdk'
import { useV3PositionFromTokenId } from 'hooks/useV3Positions'
import { useDerivedPositionInfo } from 'hooks/useDerivedPositionInfo'
import { PositionPreview } from 'components/PositionPreview'
import FeeSelector from 'components/FeeSelector'
import RangeSelector from 'components/RangeSelector'
import RateToggle from 'components/RateToggle'
import { BigNumber } from '@ethersproject/bignumber'
import { AddRemoveTabs } from 'components/NavigationTabs'
import HoverInlineText from 'components/HoverInlineText'
import { SwitchLocaleLink } from 'components/SwitchLocaleLink'
import * as anchor from '@project-serum/anchor'
import { Token, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token'
import idl from '../../constants/cyclos-core.json'
import { CyclosCore, IDL } from 'types/cyclos-core'
import { Wallet } from '@project-serum/anchor/dist/cjs/provider'
import { u16ToSeed } from 'state/mint/v3/utils'

const DEFAULT_ADD_IN_RANGE_SLIPPAGE_TOLERANCE = new Percent(50, 10_000)

export default function AddLiquidity({
  match: {
    params: { currencyIdA, currencyIdB, feeAmount: feeAmountFromUrl, tokenId },
  },
  history,
}: RouteComponentProps<{ currencyIdA?: string; currencyIdB?: string; feeAmount?: string; tokenId?: string }>) {
  const { account, chainId, librarySol } = useActiveWeb3ReactSol()
  const { connect } = useWalletKit()
  const { disconnect, connected, walletProviderInfo, wallet, connection, providerMut } = useSolana()
  const { PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } = anchor.web3
  const { BN } = anchor

  const theme = useContext(ThemeContext)
  const toggleWalletModal = useWalletModalToggle() // toggle wallet when disconnected
  const expertMode = useIsExpertMode()
  const addTransaction = useTransactionAdder()
  const positionManager = useV3NFTPositionManagerContract()

  // check for existing position if tokenId in url
  const { position: existingPositionDetails, loading: positionLoading } = useV3PositionFromTokenId(
    tokenId ? BigNumber.from(tokenId) : undefined
  )
  const hasExistingPosition = !!existingPositionDetails && !positionLoading
  const { position: existingPosition } = useDerivedPositionInfo(existingPositionDetails)

  // fee selection from url
  const feeAmount: FeeAmount | undefined =
    feeAmountFromUrl && Object.values(FeeAmount).includes(parseFloat(feeAmountFromUrl))
      ? parseFloat(feeAmountFromUrl)
      : undefined

  const currencyA = useCurrency(currencyIdA)
  const currencyB = useCurrency(currencyIdB)

  // keep track for UI display purposes of user selected base currency
  const baseCurrency = currencyA
  const quoteCurrency = useMemo(
    () =>
      currencyA && currencyB && baseCurrency ? (baseCurrency.equals(currencyA) ? currencyB : currencyA) : undefined,
    [currencyA, currencyB, baseCurrency]
  )

  // mint state
  const { independentField, typedValue, startPriceTypedValue } = useV3MintState()

  const {
    pool,
    ticks,
    dependentField,
    price,
    pricesAtTicks,
    parsedAmounts,
    currencyBalances,
    position,
    noLiquidity,
    currencies,
    errorMessage,
    invalidPool,
    invalidRange,
    outOfRange,
    depositADisabled,
    depositBDisabled,
    invertPrice,
  } = useV3DerivedMintInfo(
    currencyA ?? undefined,
    currencyB ?? undefined,
    feeAmount,
    baseCurrency ?? undefined,
    existingPosition
  )

  const { onFieldAInput, onFieldBInput, onLeftRangeInput, onRightRangeInput, onStartPriceInput } =
    useV3MintActionHandlers(noLiquidity)

  const isValid = !errorMessage && !invalidRange

  // modal and loading
  const [showConfirm, setShowConfirm] = useState<boolean>(false)
  const [attemptingTxn, setAttemptingTxn] = useState<boolean>(false) // clicked confirm

  // txn values
  const deadline = useTransactionDeadline() // custom from users settings

  const [txHash, setTxHash] = useState<string>('')

  // get formatted amounts
  const formattedAmounts = {
    [independentField]: typedValue,
    [dependentField]: parsedAmounts[dependentField]?.toSignificant(6) ?? '',
  }

  const usdcValues = {
    [Field.CURRENCY_A]: useUSDCValue(parsedAmounts[Field.CURRENCY_A]),
    [Field.CURRENCY_B]: useUSDCValue(parsedAmounts[Field.CURRENCY_B]),
  }

  // get the max amounts user can add
  const maxAmounts: { [field in Field]?: CurrencyAmount<Currency> } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmountSpend(currencyBalances[field]),
      }
    },
    {}
  )

  const atMaxAmounts: { [field in Field]?: CurrencyAmount<Currency> } = [Field.CURRENCY_A, Field.CURRENCY_B].reduce(
    (accumulator, field) => {
      return {
        ...accumulator,
        [field]: maxAmounts[field]?.equalTo(parsedAmounts[field] ?? '0'),
      }
    },
    {}
  )

  // check whether the user has approved the router on the tokens
  const [approvalA, approveACallback] = useApproveCallback(
    parsedAmounts[Field.CURRENCY_A],
    chainId ? NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId] : undefined
  )
  const [approvalB, approveBCallback] = useApproveCallback(
    parsedAmounts[Field.CURRENCY_B],
    chainId ? NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId] : undefined
  )

  const allowedSlippage = useUserSlippageToleranceWithDefault(
    outOfRange ? ZERO_PERCENT : DEFAULT_ADD_IN_RANGE_SLIPPAGE_TOLERANCE
  )

  async function OnAdd() {
    if (!wallet?.publicKey || !currencyA?.wrapped.address || !currencyB?.wrapped.address) return

    const provider = new anchor.Provider(connection, wallet as Wallet, {
      skipPreflight: false,
    })
    const cyclosCore = new anchor.Program<CyclosCore>(IDL, PROGRAM_ID_STR, provider)

    const fee = 500
    const tickSpacing = 10

    // Convinence helpers
    const tokenA = currencyA?.wrapped
    const tokenB = currencyB?.wrapped
    const [tk1, tk2] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]

    const token1 = new anchor.web3.PublicKey(tk1.address)
    const token2 = new anchor.web3.PublicKey(tk2.address)

    // create fee state
    const [feeState, feeStateBump] = await anchor.web3.PublicKey.findProgramAddress(
      [FEE_SEED, u32ToSeed(fee)],
      cyclosCore.programId
    )
    console.log(`feeState -> ${feeState.toString()}`)
    // create pool state
    const [poolState, poolStateBump] = await PublicKey.findProgramAddress(
      [POOL_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee)],
      cyclosCore.programId
    )
    console.log(`poolState -> ${poolState.toString()}`)

    // create init Observation state
    const [initialObservationState, initialObservationBump] = await PublicKey.findProgramAddress(
      [OBSERVATION_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee), u16ToSeed(0)],
      cyclosCore.programId
    )
    console.log(`initialObservationState -> ${initialObservationState.toString()}`)

    // get init Price from UI - should encode into Q32.32
    // taken from test file
    const initPrice = new BN(4297115210)

    // taken as contants in test file
    const tickLower = 0
    const tickUpper = 10
    const wordPosLower = (tickLower / tickSpacing) >> 8
    const wordPosUpper = (tickUpper / tickSpacing) >> 8

    //fetch ATA of pool tokens
    const vault1 = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token2,
      poolState,
      true
    )
    console.log(`vault1 -> ${vault1.toString()}`)
    const vault0 = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token1,
      poolState,
      true
    )
    console.log(`vault0 -> ${vault0.toString()}`)

    //fetch ATA of pool tokens
    const userATA0 = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token1,
      wallet?.publicKey,
      true
    )
    console.log(`user ATA 0 -> ${userATA0.toString()}`)
    const userATA1 = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      token2,
      wallet?.publicKey,
      true
    )
    console.log(`user ATA 1 -> ${userATA1.toString()}`)

    // If pool not exist, create and init pool and create tick and bitmap tokens accounts
    //  this can be checked using `noLiquidity`

    // Create and init pool
    if (noLiquidity) {
      console.log('Creating and init pool')
      const createHash = await cyclosCore.rpc.createAndInitPool(poolStateBump, initialObservationBump, initPrice, {
        accounts: {
          poolCreator: wallet?.publicKey,
          token0: token1,
          token1: token2,
          feeState,
          poolState,
          initialObservationState,
          vault0,
          vault1,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        },
      })

      console.log(createHash, ' txn hash for create Pool')
    }

    // Create tick and bitmap accounts
    const [tickLowerState, tickLowerStateBump] = await PublicKey.findProgramAddress(
      [TICK_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee), u32ToSeed(tickLower)],
      cyclosCore.programId
    )

    const [tickUpperState, tickUpperStateBump] = await PublicKey.findProgramAddress(
      [TICK_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee), u32ToSeed(tickUpper)],
      cyclosCore.programId
    )

    const [bitmapLowerState, bitmapLowerBump] = await PublicKey.findProgramAddress(
      [BITMAP_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee), u16ToSeed(wordPosLower)],
      cyclosCore.programId
    )
    const [bitmapUpperState, bitmapUpperBump] = await PublicKey.findProgramAddress(
      [BITMAP_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee), u16ToSeed(wordPosUpper)],
      cyclosCore.programId
    )

    const [factoryState, factoryStateBump] = await PublicKey.findProgramAddress([], cyclosCore.programId)

    const [corePositionState, corePositionBump] = await PublicKey.findProgramAddress(
      [
        POSITION_SEED,
        token1.toBuffer(),
        token2.toBuffer(),
        u32ToSeed(fee),
        factoryState.toBuffer(),
        u32ToSeed(tickLower),
        u32ToSeed(tickUpper),
      ],
      cyclosCore.programId
    )

    const tickLowerStateInfo = await connection.getAccountInfo(tickLowerState)
    const tickUpperStateInfo = await connection.getAccountInfo(tickUpperState)
    const bitmapLowerStateInfo = await connection.getAccountInfo(bitmapLowerState)
    const bitmapUpperStateInfo = await connection.getAccountInfo(bitmapUpperState)
    const factoryStateInfo = await connection.getAccountInfo(factoryState)
    const corePositionStateInfo = await connection.getAccountInfo(corePositionState)

    // Build the transaction
    if (
      noLiquidity &&
      !corePositionStateInfo &&
      !tickLowerStateInfo &&
      !tickUpperStateInfo &&
      !bitmapLowerStateInfo &&
      !factoryStateInfo
    ) {
      console.log('Creating all accounts')

      const tx = new Transaction()
      tx.recentBlockhash = (await connection.getRecentBlockhash()).blockhash
      tx.instructions = [
        cyclosCore.instruction.initTickAccount(tickLowerStateBump, tickLower, {
          accounts: {
            signer: wallet?.publicKey,
            poolState: poolState,
            tickState: tickLowerState,
            systemProgram: SystemProgram.programId,
          },
        }),
        cyclosCore.instruction.initTickAccount(tickUpperStateBump, tickUpper, {
          accounts: {
            signer: wallet?.publicKey,
            poolState: poolState,
            tickState: tickUpperState,
            systemProgram: SystemProgram.programId,
          },
        }),
        cyclosCore.instruction.initBitmapAccount(bitmapLowerBump, wordPosLower, {
          accounts: {
            signer: wallet?.publicKey,
            poolState: poolState,
            bitmapState: bitmapLowerState,
            systemProgram: SystemProgram.programId,
          },
        }),
        cyclosCore.instruction.initPositionAccount(corePositionBump, {
          accounts: {
            signer: wallet?.publicKey,
            recipient: factoryState,
            poolState: poolState,
            tickLowerState: tickLowerState,
            tickUpperState: tickUpperState,
            positionState: corePositionState,
            systemProgram: SystemProgram.programId,
          },
        }),
      ]
      tx.feePayer = wallet?.publicKey ?? undefined
      await wallet?.signTransaction(tx)

      const hash = await providerMut?.send(tx)
      console.log(hash, ' -> create account hash')
    }

    console.log('Not creating account and init pool')
    // Then finally mint the required position
    // Need to fix this wallet.publicKey is undefined
    const nftMintKeypair = new anchor.web3.Keypair()

    const [tokenizedPositionState, tokenizedPositionBump] = await PublicKey.findProgramAddress(
      [POSITION_SEED, nftMintKeypair.publicKey.toBuffer()],
      cyclosCore.programId
    )

    const positionNftAccount = await Token.getAssociatedTokenAddress(
      ASSOCIATED_TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      nftMintKeypair.publicKey,
      wallet.publicKey
    )

    const amount0Desired = new BN(0)
    const amount1Desired = new BN(1_000_000)
    const deadline = new BN(Date.now() / 1000 + 10_000)

    // fetch observation accounts
    const { observationIndex, observationCardinalityNext } = await cyclosCore.account.poolState.fetch(poolState)

    const latestObservationState = (
      await PublicKey.findProgramAddress(
        [OBSERVATION_SEED, token1.toBuffer(), token2.toBuffer(), u32ToSeed(fee), u16ToSeed(observationIndex)],
        cyclosCore.programId
      )
    )[0]

    const nextObservationState = (
      await PublicKey.findProgramAddress(
        [
          OBSERVATION_SEED,
          token1.toBuffer(),
          token2.toBuffer(),
          u32ToSeed(fee),
          u16ToSeed((observationIndex + 1) % observationCardinalityNext),
        ],
        cyclosCore.programId
      )
    )[0]

    const hashRes = await cyclosCore.rpc.mintTokenizedPosition(
      tokenizedPositionBump,
      amount0Desired,
      amount1Desired,
      new BN(0),
      new BN(0),
      deadline,
      {
        accounts: {
          minter: wallet?.publicKey,
          recipient: wallet?.publicKey,
          factoryState,
          nftMint: nftMintKeypair.publicKey,
          nftAccount: positionNftAccount,
          poolState: poolState,
          corePositionState: corePositionState,
          tickLowerState: tickLowerState,
          tickUpperState: tickUpperState,
          bitmapLowerState: bitmapLowerState,
          bitmapUpperState: bitmapUpperState,
          tokenAccount0: userATA0,
          tokenAccount1: userATA1,
          vault0: vault0,
          vault1: vault1,
          latestObservationState: latestObservationState,
          nextObservationState: nextObservationState,
          tokenizedPositionState: tokenizedPositionState,
          coreProgram: cyclosCore.programId,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        },
        signers: [nftMintKeypair],
      }
    )
    console.log(hashRes)
  }

  // replace this eventually with onAdd()
  async function onAdder() {
    if (!chainId || !librarySol || !account) return

    if (!positionManager || !currencyA || !currencyB) {
      return
    }

    if (position && account && deadline) {
      const useNative = currencyA.isNative ? currencyA : currencyB.isNative ? currencyB : undefined
      const { calldata, value } =
        hasExistingPosition && tokenId
          ? NonfungiblePositionManager.addCallParameters(position, {
              tokenId,
              slippageTolerance: allowedSlippage,
              deadline: deadline.toString(),
              useNative,
            })
          : NonfungiblePositionManager.addCallParameters(position, {
              slippageTolerance: allowedSlippage,
              recipient: account,
              deadline: deadline.toString(),
              useNative,
              createPool: noLiquidity,
            })

      const txn: { to: string; data: string; value: string } = {
        to: NONFUNGIBLE_POSITION_MANAGER_ADDRESSES[chainId],
        data: calldata,
        value,
      }

      setAttemptingTxn(true)

      librarySol
        ?.getSigner()
        .estimateGas(txn)
        .then((estimate: BigNumber) => {
          const newTxn = {
            ...txn,
            gasLimit: calculateGasMargin(estimate),
          }

          return librarySol
            ?.getSigner()
            .sendTransaction(newTxn)
            .then((response: TransactionResponse) => {
              setAttemptingTxn(false)
              addTransaction(response, {
                summary: noLiquidity
                  ? t`Create pool and add ${currencyA?.symbol}/${currencyB?.symbol} V3 liquidity`
                  : t`Add ${currencyA?.symbol}/${currencyB?.symbol} V3 liquidity`,
              })
              setTxHash(response.hash)
              ReactGA.event({
                category: 'Liquidity',
                action: 'Add',
                label: [currencies[Field.CURRENCY_A]?.symbol, currencies[Field.CURRENCY_B]?.symbol].join('/'),
              })
            })
        })
        .catch((error: any) => {
          console.error('Failed to send transaction', error)
          setAttemptingTxn(false)
          // we only care if the error is something _other_ than the user rejected the tx
          if (error?.code !== 4001) {
            console.error(error)
          }
        })
    } else {
      return
    }
  }

  const pendingText = `Supplying ${!depositADisabled ? parsedAmounts[Field.CURRENCY_A]?.toSignificant(6) : ''} ${
    !depositADisabled ? currencies[Field.CURRENCY_A]?.symbol : ''
  } ${!outOfRange ? 'and' : ''} ${!depositBDisabled ? parsedAmounts[Field.CURRENCY_B]?.toSignificant(6) : ''} ${
    !depositBDisabled ? currencies[Field.CURRENCY_B]?.symbol : ''
  }`

  const handleCurrencySelect = useCallback(
    (currencyNew: Currency, currencyIdOther?: string): (string | undefined)[] => {
      const currencyIdNew = currencyId(currencyNew)

      if (currencyIdNew === currencyIdOther) {
        // not ideal, but for now clobber the other if the currency ids are equal
        return [currencyIdNew, undefined]
      } else {
        // prevent weth + eth
        const isETHOrWETHNew =
          currencyIdNew === 'wSOL' || (chainId !== undefined && currencyIdNew === SOL_LOCAL.address)
        const isETHOrWETHOther =
          currencyIdOther !== undefined &&
          (currencyIdOther === 'wSOL' || (chainId !== undefined && currencyIdOther === SOL_LOCAL.address))

        if (isETHOrWETHNew && isETHOrWETHOther) {
          return [currencyIdNew, undefined]
        } else {
          return [currencyIdNew, currencyIdOther]
        }
      }
    },
    [chainId]
  )

  const handleCurrencyASelect = useCallback(
    (currencyANew: Currency) => {
      const [idA, idB] = handleCurrencySelect(currencyANew, currencyIdB)
      if (idB === undefined) {
        history.push(`/add/${idA}`)
      } else {
        history.push(`/add/${idA}/${idB}`)
      }
    },
    [handleCurrencySelect, currencyIdB, history]
  )

  const handleCurrencyBSelect = useCallback(
    (currencyBNew: Currency) => {
      const [idB, idA] = handleCurrencySelect(currencyBNew, currencyIdA)
      if (idA === undefined) {
        history.push(`/add/${idB}`)
      } else {
        history.push(`/add/${idA}/${idB}`)
      }
    },
    [handleCurrencySelect, currencyIdA, history]
  )

  const handleFeePoolSelect = useCallback(
    (newFeeAmount: FeeAmount) => {
      history.push(`/add/${currencyIdA}/${currencyIdB}/${newFeeAmount}`)
    },
    [currencyIdA, currencyIdB, history]
  )

  const handleDismissConfirmation = useCallback(() => {
    setShowConfirm(false)
    // if there was a tx hash, we want to clear the input
    if (txHash) {
      onFieldAInput('')
      history.push('/pool')
    }
    setTxHash('')
  }, [history, onFieldAInput, txHash])

  const addIsUnsupported = useIsSwapUnsupported(currencies?.CURRENCY_A, currencies?.CURRENCY_B)

  const clearAll = useCallback(() => {
    onFieldAInput('')
    onFieldBInput('')
    onLeftRangeInput('')
    onRightRangeInput('')
    history.push(`/add`)
  }, [history, onFieldAInput, onFieldBInput, onLeftRangeInput, onRightRangeInput])

  // get value and prices at ticks
  const { [Bound.LOWER]: tickLower, [Bound.UPPER]: tickUpper } = ticks
  const { [Bound.LOWER]: priceLower, [Bound.UPPER]: priceUpper } = pricesAtTicks

  const { getDecrementLower, getIncrementLower, getDecrementUpper, getIncrementUpper } = useRangeHopCallbacks(
    baseCurrency ?? undefined,
    quoteCurrency ?? undefined,
    feeAmount,
    tickLower,
    tickUpper,
    pool
  )

  // we need an existence check on parsed amounts for single-asset deposits
  const showApprovalA = approvalA !== ApprovalState.APPROVED && !!parsedAmounts[Field.CURRENCY_A]
  const showApprovalB = approvalB !== ApprovalState.APPROVED && !!parsedAmounts[Field.CURRENCY_B]

  return (
    <>
      <ScrollablePage>
        <NetworkAlert />
        <TransactionConfirmationModal
          isOpen={showConfirm}
          onDismiss={handleDismissConfirmation}
          attemptingTxn={attemptingTxn}
          hash={txHash}
          content={() => (
            <ConfirmationModalContent
              title={'Add Liquidity'}
              onDismiss={handleDismissConfirmation}
              topContent={() => (
                <Review
                  parsedAmounts={parsedAmounts}
                  position={position}
                  existingPosition={existingPosition}
                  priceLower={priceLower}
                  priceUpper={priceUpper}
                  outOfRange={outOfRange}
                />
              )}
              bottomContent={() => (
                <ButtonPrimary style={{ marginTop: '1rem' }} onClick={OnAdd}>
                  <Text fontWeight={500} fontSize={20}>
                    <Trans>Add</Trans>
                  </Text>
                </ButtonPrimary>
              )}
            />
          )}
          pendingText={pendingText}
        />
        <AppBody>
          <AddRemoveTabs
            creating={false}
            adding={true}
            positionID={tokenId}
            defaultSlippage={DEFAULT_ADD_IN_RANGE_SLIPPAGE_TOLERANCE}
          />
          <Wrapper>
            <AutoColumn gap="32px">
              {!hasExistingPosition && (
                <>
                  <AutoColumn gap="md">
                    <RowBetween paddingBottom="20px">
                      <TYPE.label>
                        <Trans>Select pair</Trans>
                      </TYPE.label>
                      <ButtonText onClick={clearAll}>
                        <TYPE.blue fontSize="12px">
                          <Trans>Clear All</Trans>
                        </TYPE.blue>
                      </ButtonText>
                    </RowBetween>
                    <RowBetween>
                      <CurrencyDropdown
                        value={formattedAmounts[Field.CURRENCY_A]}
                        onUserInput={onFieldAInput}
                        hideInput={true}
                        onMax={() => {
                          onFieldAInput(maxAmounts[Field.CURRENCY_A]?.toExact() ?? '')
                        }}
                        onCurrencySelect={handleCurrencyASelect}
                        showMaxButton={!atMaxAmounts[Field.CURRENCY_A]}
                        currency={currencies[Field.CURRENCY_A]}
                        id="add-liquidity-input-tokena"
                        showCommonBases
                      />
                      <div style={{ width: '12px' }} />

                      <CurrencyDropdown
                        value={formattedAmounts[Field.CURRENCY_B]}
                        hideInput={true}
                        onUserInput={onFieldBInput}
                        onCurrencySelect={handleCurrencyBSelect}
                        onMax={() => {
                          onFieldBInput(maxAmounts[Field.CURRENCY_B]?.toExact() ?? '')
                        }}
                        showMaxButton={!atMaxAmounts[Field.CURRENCY_B]}
                        currency={currencies[Field.CURRENCY_B]}
                        id="add-liquidity-input-tokenb"
                        showCommonBases
                      />
                    </RowBetween>

                    <FeeSelector
                      disabled={!currencyB || !currencyA}
                      feeAmount={feeAmount}
                      handleFeePoolSelect={handleFeePoolSelect}
                      token0={currencyA?.wrapped}
                      token1={currencyB?.wrapped}
                    />
                  </AutoColumn>{' '}
                </>
              )}

              {hasExistingPosition && existingPosition ? (
                <PositionPreview
                  position={existingPosition}
                  title={<Trans>Selected Range</Trans>}
                  inRange={!outOfRange}
                />
              ) : (
                <>
                  {noLiquidity && (
                    <DynamicSection disabled={!currencyA || !currencyB}>
                      <AutoColumn gap="md">
                        <RowBetween>
                          <TYPE.label>
                            <Trans>Set Starting Price</Trans>
                          </TYPE.label>
                          {baseCurrency && quoteCurrency ? (
                            <RateToggle
                              currencyA={baseCurrency}
                              currencyB={quoteCurrency}
                              handleRateToggle={() => {
                                onLeftRangeInput('')
                                onRightRangeInput('')
                                history.push(
                                  `/add/${currencyIdB as string}/${currencyIdA as string}${
                                    feeAmount ? '/' + feeAmount : ''
                                  }`
                                )
                              }}
                            />
                          ) : null}
                        </RowBetween>

                        <OutlineCard padding="12px">
                          <StyledInput
                            className="start-price-input"
                            value={startPriceTypedValue}
                            onUserInput={onStartPriceInput}
                          />
                        </OutlineCard>
                        <RowBetween style={{ backgroundColor: theme.bg1, padding: '12px', borderRadius: '12px' }}>
                          <TYPE.main>
                            <Trans>Current {baseCurrency?.symbol} Price:</Trans>
                          </TYPE.main>
                          <TYPE.main>
                            {price ? (
                              <TYPE.main>
                                <RowFixed>
                                  <HoverInlineText
                                    maxCharacters={20}
                                    text={invertPrice ? price?.invert()?.toSignificant(5) : price?.toSignificant(5)}
                                  />{' '}
                                  <span style={{ marginLeft: '4px' }}>{quoteCurrency?.symbol}</span>
                                </RowFixed>
                              </TYPE.main>
                            ) : (
                              '-'
                            )}
                          </TYPE.main>
                        </RowBetween>
                        <BlueCard
                          style={{
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            padding: ' 1.5rem 1.25rem',
                          }}
                        >
                          <AlertCircle color={theme.text1} size={32} style={{ marginBottom: '12px', opacity: 0.8 }} />
                          <TYPE.body
                            fontSize={14}
                            style={{ marginBottom: 8, fontWeight: 500, opacity: 0.8 }}
                            textAlign="center"
                          >
                            You are the first liquidity provider for this Uniswap V3 pool.
                          </TYPE.body>

                          <TYPE.body fontWeight={500} textAlign="center" fontSize={14} style={{ opacity: 0.8 }}>
                            The transaction cost will be much higher as it includes the gas to create the pool.
                          </TYPE.body>
                        </BlueCard>
                      </AutoColumn>
                    </DynamicSection>
                  )}

                  <DynamicSection
                    gap="md"
                    disabled={!feeAmount || invalidPool || (noLiquidity && !startPriceTypedValue)}
                  >
                    <RowBetween>
                      <TYPE.label>
                        <Trans>Set Price Range</Trans>
                      </TYPE.label>

                      {baseCurrency && quoteCurrency ? (
                        <RateToggle
                          currencyA={baseCurrency}
                          currencyB={quoteCurrency}
                          handleRateToggle={() => {
                            onLeftRangeInput('')
                            onRightRangeInput('')
                            history.push(
                              `/add/${currencyIdB as string}/${currencyIdA as string}${
                                feeAmount ? '/' + feeAmount : ''
                              }`
                            )
                          }}
                        />
                      ) : null}
                    </RowBetween>
                    <TYPE.main fontSize={14} fontWeight={400} style={{ marginBottom: '.5rem', lineHeight: '125%' }}>
                      <Trans>
                        Your liquidity will only earn fees when the market price of the pair is within your range.{' '}
                        <ExternalLink
                          href={'https://docs.uniswap.org/concepts/introduction/liquidity-user-guide#4-set-price-range'}
                          style={{ fontSize: '14px' }}
                        >
                          Need help picking a range?
                        </ExternalLink>
                      </Trans>
                    </TYPE.main>

                    <RangeSelector
                      priceLower={priceLower}
                      priceUpper={priceUpper}
                      getDecrementLower={getDecrementLower}
                      getIncrementLower={getIncrementLower}
                      getDecrementUpper={getDecrementUpper}
                      getIncrementUpper={getIncrementUpper}
                      onLeftRangeInput={onLeftRangeInput}
                      onRightRangeInput={onRightRangeInput}
                      currencyA={baseCurrency}
                      currencyB={quoteCurrency}
                      feeAmount={feeAmount}
                    />

                    {price && baseCurrency && quoteCurrency && !noLiquidity && (
                      <LightCard style={{ padding: '12px' }}>
                        <AutoColumn gap="4px">
                          <TYPE.main fontWeight={500} textAlign="center" fontSize={12}>
                            <Trans>Current Price</Trans>
                          </TYPE.main>
                          <TYPE.body fontWeight={500} textAlign="center" fontSize={20}>
                            <HoverInlineText
                              maxCharacters={20}
                              text={invertPrice ? price.invert().toSignificant(6) : price.toSignificant(6)}
                            />{' '}
                          </TYPE.body>
                          <TYPE.main fontWeight={500} textAlign="center" fontSize={12}>
                            <Trans>
                              {quoteCurrency?.symbol} per {baseCurrency.symbol}
                            </Trans>
                          </TYPE.main>
                        </AutoColumn>
                      </LightCard>
                    )}

                    {outOfRange ? (
                      <YellowCard padding="8px 12px" $borderRadius="12px">
                        <RowBetween>
                          <AlertTriangle stroke={theme.yellow3} size="16px" />
                          <TYPE.yellow ml="12px" fontSize="12px">
                            <Trans>
                              Your position will not earn fees or be used in trades until the market price moves into
                              your range.
                            </Trans>
                          </TYPE.yellow>
                        </RowBetween>
                      </YellowCard>
                    ) : null}

                    {invalidRange ? (
                      <YellowCard padding="8px 12px" $borderRadius="12px">
                        <RowBetween>
                          <AlertTriangle stroke={theme.yellow3} size="16px" />
                          <TYPE.yellow ml="12px" fontSize="12px">
                            <Trans>Invalid range selected. The min price must be lower than the max price.</Trans>
                          </TYPE.yellow>
                        </RowBetween>
                      </YellowCard>
                    ) : null}
                  </DynamicSection>
                </>
              )}

              <DynamicSection
                disabled={tickLower === undefined || tickUpper === undefined || invalidPool || invalidRange}
              >
                <AutoColumn gap="md">
                  <TYPE.label>{hasExistingPosition ? 'Add more liquidity' : t`Deposit Amounts`}</TYPE.label>

                  <CurrencyInputPanel
                    value={formattedAmounts[Field.CURRENCY_A]}
                    onUserInput={onFieldAInput}
                    onMax={() => {
                      onFieldAInput(maxAmounts[Field.CURRENCY_A]?.toExact() ?? '')
                    }}
                    showMaxButton={!atMaxAmounts[Field.CURRENCY_A]}
                    currency={currencies[Field.CURRENCY_A]}
                    id="add-liquidity-input-tokena"
                    fiatValue={usdcValues[Field.CURRENCY_A]}
                    showCommonBases
                    locked={depositADisabled}
                  />

                  <CurrencyInputPanel
                    value={formattedAmounts[Field.CURRENCY_B]}
                    onUserInput={onFieldBInput}
                    onMax={() => {
                      onFieldBInput(maxAmounts[Field.CURRENCY_B]?.toExact() ?? '')
                    }}
                    showMaxButton={!atMaxAmounts[Field.CURRENCY_B]}
                    fiatValue={usdcValues[Field.CURRENCY_B]}
                    currency={currencies[Field.CURRENCY_B]}
                    id="add-liquidity-input-tokenb"
                    showCommonBases
                    locked={depositBDisabled}
                  />
                </AutoColumn>
              </DynamicSection>
              <div>
                {addIsUnsupported ? (
                  <ButtonPrimary disabled={true} $borderRadius="12px" padding={'12px'}>
                    <TYPE.main mb="4px">
                      <Trans>Unsupported Asset</Trans>
                    </TYPE.main>
                  </ButtonPrimary>
                ) : !connected ? (
                  <ButtonLight onClick={connect} $borderRadius="12px" padding={'12px'}>
                    <Trans>Connect wallet</Trans>
                  </ButtonLight>
                ) : (
                  <AutoColumn gap={'md'}>
                    {(approvalA === ApprovalState.NOT_APPROVED ||
                      approvalA === ApprovalState.PENDING ||
                      approvalB === ApprovalState.NOT_APPROVED ||
                      approvalB === ApprovalState.PENDING) &&
                      isValid && (
                        <RowBetween>
                          {showApprovalA && (
                            <ButtonPrimary
                              onClick={approveACallback}
                              disabled={approvalA === ApprovalState.PENDING}
                              width={showApprovalB ? '48%' : '100%'}
                            >
                              {approvalA === ApprovalState.PENDING ? (
                                <Dots>
                                  <Trans>Approving {currencies[Field.CURRENCY_A]?.symbol}</Trans>
                                </Dots>
                              ) : (
                                <Trans>Approve {currencies[Field.CURRENCY_A]?.symbol}</Trans>
                              )}
                            </ButtonPrimary>
                          )}
                          {showApprovalB && (
                            <ButtonPrimary
                              onClick={approveBCallback}
                              disabled={approvalB === ApprovalState.PENDING}
                              width={showApprovalA ? '48%' : '100%'}
                            >
                              {approvalB === ApprovalState.PENDING ? (
                                <Dots>
                                  <Trans>Approving {currencies[Field.CURRENCY_B]?.symbol}</Trans>
                                </Dots>
                              ) : (
                                <Trans>Approve {currencies[Field.CURRENCY_B]?.symbol}</Trans>
                              )}
                            </ButtonPrimary>
                          )}
                        </RowBetween>
                      )}
                    <ButtonError
                      onClick={() => {
                        expertMode ? OnAdd() : setShowConfirm(true)
                      }}
                      disabled={
                        !isValid ||
                        (approvalA !== ApprovalState.APPROVED && !depositADisabled) ||
                        (approvalB !== ApprovalState.APPROVED && !depositBDisabled)
                      }
                      error={!isValid && !!parsedAmounts[Field.CURRENCY_A] && !!parsedAmounts[Field.CURRENCY_B]}
                    >
                      <Text fontWeight={500}>{errorMessage ? errorMessage : <Trans>Add</Trans>}</Text>
                    </ButtonError>
                  </AutoColumn>
                )}
              </div>
            </AutoColumn>
          </Wrapper>
        </AppBody>
        {addIsUnsupported && (
          <UnsupportedCurrencyFooter
            show={addIsUnsupported}
            currencies={[currencies.CURRENCY_A, currencies.CURRENCY_B]}
          />
        )}
      </ScrollablePage>
      <SwitchLocaleLink />
    </>
  )
}
